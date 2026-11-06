"""Credential-free JSONL bridge. Install the exact requirements on every Ray node."""
import contextlib
import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time

PROTOCOL = 2
RAY_VERSION = "2.58.0"
PYTHON_VERSION = (3, 12, 14)
MAX_MESSAGE = 2 * 1024 * 1024
OUTPUT_LOCK = threading.Lock()


class RetiredNodeFailure(Exception):
    """Raised only after the Node subprocess has definitely exited."""

    def __init__(self, message, code=None, network=None, environment_timeouts=None):
        super().__init__(message)
        self.code = code
        self.network = network
        self.environment_timeouts = environment_timeouts


def error_code(error):
    cause = getattr(error, "cause", None)
    retired = cause if isinstance(cause, RetiredNodeFailure) else error
    code = getattr(retired, "code", None)
    if isinstance(retired, RetiredNodeFailure) and isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", code):
        return code
    return "RAY_WORKER_LOST"


def error_name(error):
    # Exception names are diagnostics, never framework codes or exception text.
    name = type(error).__name__.split("(", 1)[0]
    return name if name.isidentifier() and name.isascii() and len(name) <= 100 else "UnknownError"


def emit(value):
    with OUTPUT_LOCK:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def run_node(job):
    # This function receives only the projected protocol, never model auth or paths.
    import ray
    if ray.__version__ != RAY_VERSION or sys.version_info[:3] != PYTHON_VERSION:
        raise RuntimeError("Ray node Python/Ray version mismatch")
    with open(os.environ["EVALUATOR_NODE_CONFIG"], encoding="utf-8") as file:
        config = json.load(file)
    payload = {"remote": job, "nodeId": ray.get_runtime_context().get_node_id(), "hostname": socket.gethostname()}
    child = subprocess.Popen([config["nodeExecutable"], config["workerEntry"]], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, shell=False)
    output = bytearray()

    def read_output():
        while True:
            chunk = child.stdout.read(4096)
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > 65536:
                child.kill()
                break

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    failure = None
    node_failure_code = None
    network = None
    environment_timeouts = None
    try:
        child.stdin.write(json.dumps(payload).encode("utf-8"))
        child.stdin.close()
        preparation = job.get("preparation", {})
        if preparation.get("mode") == "prepare" and preparation.get("deadlineAt") is not None:
            from datetime import datetime
            remaining = datetime.fromisoformat(preparation["deadlineAt"].replace("Z", "+00:00")).timestamp() - time.time()
            deadline = time.monotonic() + max(0, remaining) + 30
        elif preparation.get("mode") == "prepare":
            deadline = float("inf")  # Stage timers and the coordinator own preparation cancellation.
        else:
            deadline = time.monotonic() + job["safeConfig"]["timeoutSeconds"] + 300
        interrupted = False
        while child.poll() is None:
            try:
                if time.monotonic() >= deadline:
                    child.kill()
                    raise RuntimeError("Ray node process deadline exceeded; inspect retained attempt evidence")
                time.sleep(0.1)
            except KeyboardInterrupt:
                # Coordinator control has already requested cancellation. Leave bounded
                # time for the independently polling Node process to collect and clean up.
                if not interrupted:
                    deadline = min(deadline, time.monotonic() + 90)
                    interrupted = True
        reader.join(timeout=5)
        if child.returncode != 0 or len(output) > 65536 or reader.is_alive():
            if child.returncode != 0 and len(output) <= 65536 and not reader.is_alive():
                try:
                    diagnostic = json.loads(output.decode("utf-8"))
                    if isinstance(diagnostic, dict) and set(diagnostic) <= {"errorCode", "network", "environmentTimeouts"} and "errorCode" in diagnostic:
                        code = diagnostic["errorCode"]
                        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,99}", code):
                            node_failure_code = code
                            network = diagnostic.get("network")
                            environment_timeouts = diagnostic.get("environmentTimeouts")
                except (ValueError, UnicodeError):
                    pass
            raise RuntimeError("Ray node worker failed; inspect retained node attempt evidence")
        result = json.loads(output.decode("utf-8"))
        fields = {"preparationDigest", "nodeId", "hostname"} if preparation.get("mode") == "prepare" else {"receipt", "nodeId", "hostname"}
        optional_fields = {"warnings", "environmentTimeouts"} if preparation.get("mode") == "prepare" else {"warnings"}
        if not isinstance(result, dict) or set(result) - optional_fields != fields:
            raise RuntimeError("Invalid Ray node worker response")
        warnings = result.get("warnings", [])
        if (not isinstance(warnings, list) or len(warnings) > 8 or
                any(not isinstance(w, str) or len(w) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in w) for w in warnings)):
            raise RuntimeError("Invalid Ray runtime warnings")
    except Exception as error:
        failure = error
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
        child.stdout.close()
    if failure is not None:
        raise RetiredNodeFailure("Node attempt exited without a collected result", node_failure_code, network, environment_timeouts) from failure
    return result


def run_cleanup(node_id, run_id, attempt_id=None):
    # Removes containers leaked by an interrupted attempt on this node. Runs
    # without evaluator_slot so it is never blocked by busy evaluation slots.
    import subprocess
    command = ["docker", "ps", "--all", "--quiet", "--filter", f"label=ember.run={run_id}"]
    if attempt_id is not None:
        command.extend(["--filter", f"label=ember.attempt={attempt_id}"])
    listed = subprocess.run(command,
                            capture_output=True, text=True, timeout=60)
    if listed.returncode != 0:
        raise RuntimeError("Ray node cleanup could not list containers")
    ids = listed.stdout.split()
    if ids:
        removed = subprocess.run(["docker", "rm", "--force", *ids], capture_output=True, text=True, timeout=120)
        if removed.returncode != 0:
            raise RuntimeError("Ray node cleanup could not remove leaked containers")
    return {"nodeId": node_id, "removed": len(ids)}


class ImageGuard:
    """The Node lease ends on stdin EOF even if its Python actor is killed."""

    def __init__(self):
        self.child = None

    def start(self, payload):
        with open(os.environ["EVALUATOR_NODE_CONFIG"], encoding="utf-8") as file:
            config = json.load(file)
        env = {name: value for name, value in os.environ.items()
               if not re.search(r"KEY|TOKEN|PASSWORD|SECRET", name, re.IGNORECASE)}
        self.child = subprocess.Popen([config["nodeExecutable"], config["workerEntry"], "--image-lease"],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      env=env, shell=False)
        try:
            self.child.stdin.write(json.dumps(payload).encode("utf-8") + b"\n")
            self.child.stdin.flush()
            ready = queue.Queue()
            threading.Thread(target=lambda: ready.put(self.child.stdout.readline(100)), daemon=True).start()
            if ready.get(timeout=60) != b"ready\n":
                raise RuntimeError("Image lease was not acknowledged")
            return True
        except BaseException:
            self.stop()
            raise

    def stop(self):
        if self.child is None:
            return
        with contextlib.suppress(BrokenPipeError, OSError):
            self.child.stdin.close()
        try:
            self.child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.child.terminate()
            try:
                self.child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=10)
        self.child.stdout.close()
        self.child = None


def run_image_cleanup(payload):
    import ray
    with open(os.environ["EVALUATOR_NODE_CONFIG"], encoding="utf-8") as file:
        config = json.load(file)
    # No model or gateway authentication is needed by a local maintenance worker.
    env = {name: value for name, value in os.environ.items()
           if not re.search(r"KEY|TOKEN|PASSWORD|SECRET", name, re.IGNORECASE)}
    child = subprocess.Popen([config["nodeExecutable"], config["workerEntry"], "--image-cleanup"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env=env, shell=False)
    try:
        output, _ = child.communicate(json.dumps(payload).encode("utf-8"), timeout=600)
        if child.returncode != 0 or len(output) > MAX_MESSAGE:
            raise RuntimeError("Image maintenance worker failed")
        result = json.loads(output.decode("utf-8"))
        result["nodeId"] = ray.get_runtime_context().get_node_id()
        return result
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)


def maintain_images(request_id, payload, node_ids, cancelled):
    import ray
    from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy
    runner = ray.remote(max_retries=0, num_cpus=0)(run_image_cleanup)
    pending = {runner.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node, soft=False)).remote(payload): node
               for node in node_ids}
    results = []
    deadline = time.monotonic() + 660
    try:
        while pending:
            if cancelled.is_set() or time.monotonic() >= deadline:
                for reference, node in pending.items():
                    ray.cancel(reference, force=False)
                # Give Node workers time to observe SIGTERM and release their lock.
                done, _ = ray.wait(list(pending), num_returns=len(pending), timeout=30)
                for reference in done:
                    try:
                        results.append(ray.get(reference))
                    except Exception:
                        results.append({"nodeId": pending[reference], "daemonId": "", "items": [], "error": "Image maintenance interrupted"})
                for reference, node in pending.items():
                    if reference not in done:
                        results.append({"nodeId": node, "daemonId": "", "items": [], "error": "Image maintenance termination is unconfirmed"})
                break
            done, _ = ray.wait(list(pending), num_returns=1, timeout=0.2)
            for reference in done:
                node = pending.pop(reference)
                try:
                    results.append(ray.get(reference))
                except Exception:
                    results.append({"nodeId": node, "daemonId": "", "items": [], "error": "Node image maintenance failed or node is unavailable"})
        emit({"type": "images-cleaned", "requestId": request_id, "preview": not payload["request"]["execute"], "nodes": results})
    except Exception:
        emit({"type": "images-cleaned", "requestId": request_id, "preview": not payload["request"]["execute"],
              "nodes": [{"nodeId": node, "daemonId": "", "items": [], "error": "Image maintenance transport failed"} for node in node_ids]})


def main():
    import ray
    from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy
    if ray.__version__ != RAY_VERSION or sys.version_info[:3] != PYTHON_VERSION:
        raise RuntimeError("Coordinator Python/Ray version mismatch")
    first = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
    if len(first) > MAX_MESSAGE:
        raise RuntimeError("Ray driver message limit exceeded")
    config = json.loads(first)
    if config.get("type") != "start" or config.get("schemaVersion") != PROTOCOL:
        raise RuntimeError("Ray driver protocol mismatch")
    endpoint = config["endpoint"]
    if endpoint not in ("local", "auto") and not endpoint.startswith("ray://"):
        raise RuntimeError("Use a Ray Client endpoint, not an HTTP Jobs endpoint")
    with contextlib.redirect_stdout(sys.stderr):
        if endpoint == "local":
            # A single-node cluster: its capacity is the configured concurrency.
            local = max(int(config.get("concurrency", 1)), 1)
            ray.init(address="local", num_cpus=local, resources={"evaluator_slot": local}, include_dashboard=False, log_to_driver=False)
        else:
            ray.init(address=endpoint, log_to_driver=False)
    from node_selection import select_nodes, node_capacity
    alive = select_nodes(ray.nodes(), config.get("nodes"))
    nodes = [node["NodeID"] for node in alive]
    # Capacity is declared per deployment as the evaluator_slot custom resource;
    # Ray only schedules attempts onto nodes with a free slot.
    slots = sum(node_capacity(node) for node in alive)
    if slots < 1:
        raise RuntimeError("Ray cluster exposes no evaluator_slot resources; start workers with --resources='{\"evaluator_slot\": N}'")
    remote = ray.remote(max_retries=0, num_cpus=1, resources={"evaluator_slot": 1})(run_node)
    commands = queue.Queue()

    def read_commands():
        try:
            while True:
                line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
                if not line:
                    break
                if len(line) > MAX_MESSAGE:
                    raise RuntimeError("Ray driver message limit exceeded")
                commands.put(json.loads(line))
        except Exception:
            commands.put({"type": "invalid"})
        finally:
            commands.put({"type": "close"})

    threading.Thread(target=read_commands, daemon=True).start()
    pending = {}
    pending_nodes = {}
    node_capacity_by_id = {node["NodeID"]: node_capacity(node) for node in alive}
    preparation_attempts = set()
    image_maintenance = {}

    def retire_attempt(key):
        try:
            cleanup = ray.remote(max_retries=0, num_cpus=0)(run_cleanup)
            references = [cleanup.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node_id, soft=False)).remote(node_id, key["runId"], key["attemptId"])
                          for node_id in nodes]
            ray.get(references, timeout=180)
            emit({"type": "retired", "attemptId": key["attemptId"], "confirmed": True})
        except Exception:
            emit({"type": "retired", "attemptId": key["attemptId"], "confirmed": False})
    guards = []
    try:
        if config.get("imageGuard"):
            guard_type = ray.remote(max_restarts=0, num_cpus=0)(ImageGuard)
            guards = [guard_type.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node, soft=False)).remote() for node in nodes]
            ray.get([guard.start.remote(config["imageGuard"]) for guard in guards], timeout=90)
        emit({"type": "ready", "schemaVersion": PROTOCOL, "rayVersion": RAY_VERSION,
              "pythonVersion": ".".join(map(str, PYTHON_VERSION)), "nodes": nodes, "slots": slots,
              "nodeSlots": {node["NodeID"]: node_capacity(node) for node in alive}})
        while True:
            try:
                command = commands.get(timeout=0.05)
                kind = command.get("type")
                if kind == "close":
                    break
                if kind == "submit":
                    job = command["job"]
                    attempt = job["job"]["attemptId"]
                    # The coordinator applies its own dispatch limit; this slot guard
                    # only backs the resource-based scheduling contract.
                    if attempt in pending or len(pending) >= slots:
                        raise RuntimeError("Ray slot or attempt identity violation")
                    preparation = job.get("preparation")
                    runner = remote
                    if not preparation:
                        # Restrict every attempt to the same selection used for preparation and cleanup.
                        selected_node = min(nodes, key=lambda node: (sum(1 for entry in pending_nodes.values() if entry == node) / node_capacity_by_id[node], node))
                        runner = remote.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=selected_node, soft=False))
                    if preparation:
                        if preparation["nodeId"] not in nodes:
                            raise RuntimeError("Prepared node is not available")
                        runner = remote.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=preparation["nodeId"], soft=False))
                        if preparation["mode"] == "prepare":
                            preparation_attempts.add(attempt)
                    pending[attempt] = runner.remote(job)
                    pending_nodes[attempt] = preparation["nodeId"] if preparation else selected_node
                elif kind == "retire":
                    if command["key"]["attemptId"] in pending:
                        raise RuntimeError("Cannot retire an active Ray attempt")
                    threading.Thread(target=retire_attempt, args=(command["key"],), daemon=True).start()
                elif kind == "cleanup":
                    if pending:
                        raise RuntimeError("Ray cleanup requires no pending attempts")
                    cleanup = ray.remote(max_retries=0, num_cpus=0)(run_cleanup)
                    references = [cleanup.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node_id, soft=False)).remote(node_id, command["runId"])
                                  for node_id in nodes]
                    results = []
                    deadline = time.monotonic() + 180
                    remaining = references
                    while remaining:
                        if time.monotonic() >= deadline:
                            for reference in remaining:
                                ray.cancel(reference, force=True)
                            raise RuntimeError("Ray node cleanup timed out")
                        done, remaining = ray.wait(remaining, num_returns=len(remaining), timeout=1)
                        for reference in done:
                            results.append(ray.get(reference))
                    emit({"type": "cleaned", "removed": sum(item["removed"] for item in results)})
                elif kind == "cleanup-images":
                    requested_nodes = command["nodes"]
                    if pending or not isinstance(requested_nodes, list) or any(node not in nodes for node in requested_nodes):
                        raise RuntimeError("Invalid image maintenance nodes")
                    request_id = command["requestId"]
                    if request_id in image_maintenance:
                        raise RuntimeError("Duplicate image maintenance request")
                    event = threading.Event()
                    thread = threading.Thread(target=maintain_images, args=(request_id, command["payload"], requested_nodes, event), daemon=True)
                    image_maintenance[request_id] = (event, thread)
                    thread.start()
                elif kind == "cancel-images":
                    entry = image_maintenance.get(command["requestId"])
                    if entry:
                        entry[0].set()
                elif kind == "cancel":
                    reference = pending.get(command["attemptId"])
                    if reference is not None:
                        ray.cancel(reference, force=bool(command.get("force", False)))
                else:
                    raise RuntimeError("Unknown Ray bridge command")
            except queue.Empty:
                pass
            if pending:
                ready, _ = ray.wait(list(pending.values()), num_returns=1, timeout=0)
                for reference in ready:
                    attempt = next(key for key, value in pending.items() if value == reference)
                    del pending[attempt]
                    del pending_nodes[attempt]
                    try:
                        result = ray.get(reference)
                        emit({"type": "prepared" if attempt in preparation_attempts else "result", "attemptId": attempt, "result": result})
                    except Exception as error:
                        # Exception text may include serialized task state. Keep it out
                        # of diagnostics and retain the node-local evidence instead.
                        emit({"type": "failed", "attemptId": attempt, "code": error_code(error), "originalName": error_name(error),
                              "retired": isinstance(getattr(error, "cause", None), RetiredNodeFailure),
                              "network": getattr(getattr(error, "cause", None), "network", None),
                              **({"environmentTimeouts": error.cause.environment_timeouts}
                                 if getattr(getattr(error, "cause", None), "environment_timeouts", None) is not None else {})})
                    finally:
                        preparation_attempts.discard(attempt)
    finally:
        for event, thread in image_maintenance.values():
            event.set()
        for event, thread in image_maintenance.values():
            thread.join(timeout=35)
        for reference in pending.values():
            ray.cancel(reference, force=False)
        if guards:
            with contextlib.suppress(Exception):
                ray.get([guard.stop.remote() for guard in guards], timeout=45)
            for guard in guards:
                ray.kill(guard, no_restart=True)
        with contextlib.redirect_stdout(sys.stderr):
            ray.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        diagnostic = {"type": "fatal", "code": "SCHEDULER_UNAVAILABLE", "originalName": error_name(error)}
        if type(error).__name__ == "RayNodeSelectionError":
            diagnostic["nodeSelection"] = {"requested": error.requested, "available": error.available}
        emit(diagnostic)
        sys.exit(1)
