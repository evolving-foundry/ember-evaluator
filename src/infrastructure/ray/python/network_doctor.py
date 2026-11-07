"""Explicit network probes on every selected execution node; no model credentials."""
import json
import os
import signal
import socket
import subprocess
import sys
import time


def probe_node(request):
    import ray
    if ray.__version__ != "2.58.0" or sys.version_info[:3] != (3, 12, 14):
        raise RuntimeError("Node Python/Ray version mismatch")
    with open(os.environ["EVALUATOR_NODE_CONFIG"], encoding="utf-8") as stream:
        node = json.load(stream)
    payload = {"network": request["network"], "packageDigest": request["packageDigest"],
               "location": ray.get_runtime_context().get_node_id() + "/" + socket.gethostname()}
    child = subprocess.Popen([node["nodeExecutable"], node["workerEntry"], "--network-doctor"],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        output, _ = child.communicate(json.dumps(payload).encode(), timeout=3000)
        if child.returncode != 0:
            raise RuntimeError("Node network probe failed")
        return json.loads(output)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=45)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=10)


def main():
    import ray
    from ray.util.scheduling_strategies import NodeAffinitySchedulingStrategy
    if ray.__version__ != "2.58.0" or sys.version_info[:3] != (3, 12, 14):
        raise RuntimeError("Coordinator Python/Ray version mismatch")
    with open(sys.argv[1], encoding="utf-8") as stream:
        request = json.load(stream)
    ray.init(address=None if request["endpoint"] == "local" else request["endpoint"], log_to_driver=False)
    pending = {}
    results = []
    def stop(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        nodes = sorted(item["NodeID"] for item in ray.nodes() if item["Alive"] and item.get("Resources", {}).get("CPU", 0) > 0)
        if request.get("nodes"):
            if len(nodes) < request["nodes"]:
                raise RuntimeError("Requested nodes are unavailable")
            nodes = nodes[:request["nodes"]]
        if not nodes:
            raise RuntimeError("No execution nodes")
        runner = ray.remote(max_retries=0, num_cpus=0)(probe_node)
        for node in nodes:
            ref = runner.options(scheduling_strategy=NodeAffinitySchedulingStrategy(node_id=node, soft=False)).remote(request)
            pending[ref] = node
        deadline = time.monotonic() + 3100
        while pending:
            if time.monotonic() >= deadline:
                raise TimeoutError("Node network probes timed out")
            ready, _ = ray.wait(list(pending), timeout=1)
            for ref in ready:
                node = pending.pop(ref)
                try:
                    results.extend(ray.get(ref))
                except Exception:
                    results.append({"name": "ray-node", "location": node, "target": "node network probes", "route": "node-local",
                                    "status": "failed", "elapsedMs": 0, "evidence": "Node probe failed or node is unavailable; verify node deployment and local network variables"})
        print(json.dumps(results))
    finally:
        for ref in pending:
            ray.cancel(ref, force=False)
        if pending:
            ray.wait(list(pending), num_returns=len(pending), timeout=55)
        ray.shutdown()


if __name__ == "__main__":
    main()
