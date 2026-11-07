"""Expose a single physical Ascend chip through bounded, read-only npu-smi queries."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import math
import re
import signal
import subprocess
import threading
import time


# Names are matched exactly after whitespace normalization. Units follow npu-smi.
FIELDS = {
    "NPU Utilization(%)": ("ascend_npu_utilization_percent", 100),
    "Aicore Usage Rate(%)": ("ascend_npu_aicore_utilization_percent", 100),
    "HBM Usage Rate(%)": ("ascend_npu_hbm_usage_percent", 100),
    "HBM Bandwidth Usage Rate(%)": ("ascend_npu_hbm_bandwidth_percent", 100),
    "HBM Capacity(MB)": ("ascend_npu_hbm_capacity_megabytes", None),
    "NPU Real-time Power(W)": ("ascend_npu_power_watts", None),
    "NPU Temperature (C)": ("ascend_npu_temperature_celsius", None),
}
QUERY_KINDS = ("usages", "memory", "power", "temp")


def parse_readings(text):
    result = {}
    for line in text.splitlines():
        key, separator, raw = line.partition(":")
        spec = FIELDS.get(" ".join(key.split()))
        if not separator or spec is None:
            continue
        if not re.fullmatch(r"\s*\d+(?:\.\d+)?\s*", raw):
            raise ValueError("Non-numeric npu-smi field: " + key.strip())
        value = float(raw)
        if not math.isfinite(value) or value < 0 or (spec[1] is not None and value > spec[1]):
            raise ValueError("Out-of-range npu-smi field: " + key.strip())
        if spec[0] in result and result[spec[0]] != value:
            raise ValueError("Conflicting npu-smi field: " + key.strip())
        result[spec[0]] = value
    return result


def read_device(device_id, chip_id, timeout=2.0, run=None, stop=None):
    run = run if run is not None else subprocess.run
    values = {}
    # usages includes HBM usage, memory provides its capacity. No all-device query.
    for kind in QUERY_KINDS:
        if stop is not None and stop.is_set():
            raise InterruptedError("NPU sampling stopped")
        command = ["npu-smi", "info", "-t", kind, "-i", str(device_id), "-c", str(chip_id)]
        output = run(command, capture_output=True, text=True, encoding="utf-8",
                     errors="replace", timeout=timeout, check=True)
        values.update(parse_readings(output.stdout))
    missing = {spec[0] for spec in FIELDS.values()} - values.keys()
    if missing:
        raise ValueError("Missing npu-smi fields: " + ", ".join(sorted(missing)))
    return values


class DeviceSampler:
    def __init__(self, device_id, chip_id, interval=1.0, timeout=2.0, reader=None):
        self.device_id, self.chip_id = device_id, chip_id
        self.interval, self.timeout = interval, timeout
        # A refresh runs four bounded queries in sequence. Keep the previous
        # snapshot valid for that budget plus the interval before a new round.
        self.max_age = max(3 * interval, len(QUERY_KINDS) * timeout + interval)
        self.stop = threading.Event()
        self.reader = reader if reader is not None else lambda d, c, t: read_device(d, c, t, stop=self.stop)
        self.lock = threading.Lock()
        self.values = None
        self.updated = None
        self.timestamp = None
        self.error = "No successful sample yet"
        self.errors = []

    def record_error(self, message):
        with self.lock:
            self.error = message
            if message not in self.errors and len(self.errors) < 20:
                self.errors.append(message)

    def sample(self):
        try:
            values = self.reader(self.device_id, self.chip_id, self.timeout)
            with self.lock:
                self.values, self.updated, self.timestamp = values, time.monotonic(), time.time()
                self.error = None
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            if isinstance(error, InterruptedError) and self.stop.is_set():
                return
            self.record_error(query_error(error))

    def run(self):
        while not self.stop.is_set():
            started = time.monotonic()
            self.sample()
            self.stop.wait(max(0, self.interval - (time.monotonic() - started)))

    def snapshot(self):
        with self.lock:
            if self.updated is not None and time.monotonic() - self.updated > self.max_age:
                if "NPU sample expired" not in self.errors:
                    self.errors.append("NPU sample expired")
                return None
            if self.error or self.updated is None:
                return None
            tags = '{device_id="%d",chip_id="%d"}' % (self.device_id, self.chip_id)
            lines = []
            for metric, value in sorted(self.values.items()):
                lines += ["# TYPE " + metric + " gauge", metric + tags + " " + str(value)]
            metric = "ascend_npu_sample_timestamp_seconds"
            lines += ["# TYPE " + metric + " gauge", metric + tags + " " + str(self.timestamp)]
            return ("\n".join(lines) + "\n").encode()


def query_error(error):
    if isinstance(error, FileNotFoundError):
        return "npu-smi executable not found in PATH"
    if isinstance(error, subprocess.TimeoutExpired):
        return "npu-smi query timed out"
    if isinstance(error, subprocess.CalledProcessError):
        return "npu-smi query failed (exit %s)" % error.returncode
    if isinstance(error, ValueError):
        return str(error)
    return "npu-smi query could not be executed"


def create_server(sampler, host, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path != "/metrics":
                self.send_error(404)
                return
            body = sampler.snapshot()
            self.send_response(200 if body is not None else 503)
            self.send_header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
            body = body if body is not None else b"NPU sample unavailable or stale\n"
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer((host, port), Handler)


def serve(sampler, host, port):
    server = create_server(sampler, host, port)
    workers = [threading.Thread(target=sampler.run, name="npu-smi-sampler"),
               threading.Thread(target=server.serve_forever, name="npu-metrics-http")]
    try:
        for worker in workers:
            worker.start()
        sampler.stop.wait()
    finally:
        sampler.stop.set()
        if workers[1].ident is not None:
            server.shutdown()
        server.server_close()
        for worker in workers:
            if worker.ident is not None:
                worker.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device-id", type=int, required=True)
    parser.add_argument("--chip-id", type=int, default=0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18095)
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--command-timeout", type=float, default=2.0)
    args = parser.parse_args()
    if args.device_id < 0 or args.chip_id < 0 or not 0 < args.port < 65536 or not all(
            math.isfinite(value) and value > 0 for value in (args.interval, args.command_timeout)):
        parser.error("Device/chip must be nonnegative; port, interval and timeout must be positive")
    sampler = DeviceSampler(args.device_id, args.chip_id, args.interval, args.command_timeout)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_args: sampler.stop.set())
    serve(sampler, args.host, args.port)


if __name__ == "__main__":
    main()
