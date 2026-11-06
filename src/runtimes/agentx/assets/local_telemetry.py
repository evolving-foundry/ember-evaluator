"""Own attempt-local NPU samplers; external telemetry services are never stopped."""
from contextlib import ExitStack
import json
import re
import signal
import subprocess
import threading

from ascend_metrics import DeviceSampler, create_server, query_error


def discover_chips(text, device_id):
    chips = set()
    for line in text.splitlines():
        # npu-smi info -m: NPU ID, Chip ID, Chip Logic ID, Chip Name.
        row = re.fullmatch(r"\s*(\d+)\s+(\d+)\s+(\d+|-)\s+(.+?)\s*", line)
        if row and int(row[1]) == device_id and row[3] != "-" and not re.search(r"\bmcu\b", row[4], re.I):
            chips.add(int(row[2]))
    if not chips:
        raise ValueError("No compute chips found for selected NPU device")
    return sorted(chips)


class LocalTelemetry:
    def __init__(self, config, artifacts, host_targets=None):
        self.config, self.artifacts = config, artifacts
        self.host_targets = host_targets
        self.sources = {kind: value for kind, value in config.items() if kind != "ascend" or value.get("mode") != "local"}
        self.targets = []
        self.samplers = []
        self.resources = ExitStack()
        self.previous_signals = {}
        if host_targets is not None:
            self.targets = host_targets
            for target in host_targets:
                if target.get("endpoint") is not None:
                    self.sources["ascend-%d-%d" % (target["deviceId"], target["chipId"])] = target

    def evidence(self):
        for target, sampler in self.samplers:
            with sampler.lock:
                target["errors"] = list(sampler.errors)
        return self.targets

    def finish(self):
        for _target, sampler in self.samplers:
            sampler.stop.set()
        self.resources.close()

    def _close_sampler(self, sampler, server, workers):
        sampler.stop.set()
        if workers[1].ident is not None:
            server.shutdown()
        server.server_close()
        for worker in workers:
            if worker.ident is not None:
                worker.join()

    def __enter__(self):
        ascend = self.config.get("ascend", {})
        if ascend.get("mode") != "local" or self.host_targets is not None:
            return self
        # SIGTERM must unwind startup as well as the running Harness. __exit__
        # restores handlers after all registered resources have been closed.
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGINT, signal.SIGTERM):
                self.previous_signals[sig] = signal.getsignal(sig)
                signal.signal(sig, self._cancel)
        try:
            mapping = None
            discovery_error = None
            if any("chipId" not in device for device in ascend["devices"]):
                try:
                    mapping = subprocess.run(["npu-smi", "info", "-m"], capture_output=True,
                                             text=True, encoding="utf-8", errors="replace", timeout=2, check=True).stdout
                except (OSError, subprocess.SubprocessError) as error:
                    discovery_error = query_error(error)
            for device in ascend["devices"]:
                try:
                    if "chipId" in device:
                        chips = [device["chipId"]]
                    else:
                        if discovery_error:
                            raise ValueError(discovery_error)
                        chips = discover_chips(mapping, device["deviceId"])
                except ValueError as error:
                    self.targets.append({"deviceId": device["deviceId"], "endpoint": None, "errors": [str(error)]})
                    continue
                for chip in chips:
                    target = {"deviceId": device["deviceId"], "chipId": chip, "endpoint": None, "errors": []}
                    self.targets.append(target)
                    sampler = DeviceSampler(device["deviceId"], chip)
                    try:
                        server = create_server(sampler, "127.0.0.1", 0)
                    except OSError:
                        target["errors"] = ["Could not bind local NPU metrics endpoint"]
                        continue
                    target["endpoint"] = "http://127.0.0.1:%d/metrics" % server.server_port
                    workers = [threading.Thread(target=sampler.run, name="npu-local-sampler"),
                               threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, name="npu-local-http")]
                    # Register cleanup before sampling or starting either thread.
                    self.resources.callback(self._close_sampler, sampler, server, workers)
                    self.samplers.append((target, sampler))
                    sampler.sample()
                    for worker in workers:
                        worker.start()
                    self.sources["ascend-%d-%d" % (device["deviceId"], chip)] = target
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    @staticmethod
    def _cancel(_signum, _frame):
        raise KeyboardInterrupt()

    def __exit__(self, *_exc):
        try:
            self.finish()
            if self.config.get("ascend", {}).get("mode") == "local":
                self.artifacts.mkdir(parents=True, exist_ok=True)
                (self.artifacts / "local-telemetry.json").write_text(
                    json.dumps({"localAscend": self.evidence()}, indent=2) + "\n", encoding="utf-8")
        finally:
            for sig, previous in self.previous_signals.items():
                signal.signal(sig, previous)
