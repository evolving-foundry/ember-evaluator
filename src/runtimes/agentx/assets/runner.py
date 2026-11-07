"""Launch the pinned AgentX CLI with locked input and bounded replay controls."""
import datetime
import importlib.metadata
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def launch_harness():
    from agentx_cli import app
    sys.argv = ["agentx", *sys.argv[2:]]
    # 1.0.7 does not expand ${VAR} in --api-key. Inject into the parsed DTO,
    # keeping the secret out of both the OS command line and the captured CLI.
    command, bound, _unused = app.parse_args(sys.argv[1:])
    bound.arguments["cli_config"].api_key = os.environ["EVALUATOR_AGENTX_API_KEY"]
    if os.environ.get("EVALUATOR_AGENTX_TELEMETRY") == "1":
        from server_metrics import install_server_metrics_adapter
        install_server_metrics_adapter()
    if os.environ.get("EVALUATOR_AGENTX_FULL_REPLAY") == "1":
        from full_replay import install_full_replay_completion, install_full_replay_metric_coverage
        install_full_replay_completion()
        install_full_replay_metric_coverage()
        # None is supported by the official DTO but cannot be expressed with
        # the positive-integer CLI flag. Mark it explicit so scenario presets
        # do not consume and shorten the beginning of each selected trace.
        bound.arguments["cli_config"].warmup_requests_per_lane = None
    command(*bound.args, **bound.kwargs)


def run():
    request = json.load(sys.stdin)
    if request["schemaVersion"] != 1:
        raise ValueError("Unsupported AgentX bridge input")
    if importlib.metadata.version("agentx-harness") != "1.0.7":
        raise ValueError("AgentX Harness version differs from 1.0.7")
    from local_telemetry import LocalTelemetry
    with LocalTelemetry(request.get("telemetry", {}), Path(request["artifactDir"]), request.get("hostAscend")) as telemetry:
        run_measurement(request, telemetry)


def run_measurement(request, telemetry):
    workload = request["workload"]
    expected = None
    if workload["mode"] == "replay":
        from replay_coverage import selected_requests
        expected = selected_requests(workload["tracePath"], workload["traceCount"])
    output = Path(request["outputDir"])
    output.mkdir(parents=True, exist_ok=True)
    artifacts = Path(request["artifactDir"])
    artifacts.mkdir(exist_ok=True)
    secrets = [request["auth"]["value"], os.environ.get("HF_TOKEN", "")]

    def redact(text):
        for secret in secrets:
            if secret:
                text = text.replace(secret, "[redacted]")
        return text

    seq = 0

    def event(kind, data):
        nonlocal seq
        seq += 1
        record = {"schemaVersion": 1, "seq": seq,
                  "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "key": request["key"], "type": kind, "data": data}
        with (output / "trajectory.jsonl").open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(redact(json.dumps(record)) + "\n")

    event("start", {"harnessVersion": "1.0.7", "workload": workload})
    (output / "session.jsonl").write_text(json.dumps({"kind": "agentx", "key": request["key"]}) + "\n", encoding="utf-8")
    args = [sys.executable, str(Path(__file__).resolve()), "--harness", "profile",
            "--scenario", "agentx", "--url", request["url"], "--endpoint", request["endpoint"],
            "--model", request["model"], "--tokenizer", request["tokenizerPath"],
            "--concurrency", str(workload["concurrency"]), "--public-dataset", workload["loader"],
            "--benchmark-duration", str(workload["durationSeconds"]), "--random-seed", str(workload["seed"]),
            "--output-artifact-dir", str(artifacts), "--ui", "none", "--no-gpu-telemetry"]
    if telemetry.sources:
        args += ["--server-metrics", *dict.fromkeys(source["endpoint"] for source in telemetry.sources.values()),
                 "--server-metrics-formats", "json", "jsonl"]
    else:
        args.append("--no-server-metrics")
    if request["trustRemoteCode"]:
        args.append("--tokenizer-trust-remote-code")
    if request.get("requestTimeoutSeconds") is not None:
        args += ["--request-timeout-seconds", str(request["requestTimeoutSeconds"])]
    network = request.get("networkLatency")
    if network is not None:
        if network["mode"] == "automatic":
            args += ["--network-latency-automatic", "--network-latency-ping-interval", str(network["pingIntervalSeconds"])]
        else:
            args += ["--network-latency-mean", str(network["meanMs"])]
    if workload["mode"] == "standard" and workload["durationSeconds"] != 3600:
        # Keep the standard trace sampling and warmup; only override the
        # scenario's minimum duration when needed. Export upstream validity as-is.
        args.append("--unsafe-override")
    elif workload["mode"] == "smoke":
        # Recorded first-request spacing can span hours. Start every smoke lane
        # immediately so a short window exercises the configured concurrency.
        args += ["--unsafe-override", "--num-dataset-entries", "1", "--warmup-requests-per-lane", "1",
                 "--burst-phase-starts"]
    elif workload["mode"] == "replay":
        args += ["--unsafe-override", "--num-dataset-entries", str(workload["traceCount"]),
                 "--num-conversations", str(workload["traceCount"]), "--dataset-sampling-strategy", "sequential",
                 "--request-count", str(sum(len(keys) for keys in expected.values())),
                 "--trajectory-start-min-ratio", "0", "--trajectory-start-max-ratio", "0"]
    environment = {**os.environ, "EVALUATOR_AGENTX_API_KEY": request["auth"]["value"],
                   "EVALUATOR_AGENTX_SOURCE": json.dumps({"path": str(Path(workload["tracePath"]).resolve()),
                                                          "dataset": workload["dataset"], "sha256": workload["sha256"]}),
                   "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    if expected is not None:
        environment["EVALUATOR_AGENTX_FULL_REPLAY"] = "1"
    if telemetry.sources:
        environment["EVALUATOR_AGENTX_TELEMETRY"] = "1"
    child = None

    def cancel(_signum, _frame):
        if child is not None and child.poll() is None:
            child.terminate()
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, cancel)
    status = "error"
    try:
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, encoding="utf-8", errors="replace", env=environment)
        event("harness", {"pid": child.pid})
        with (artifacts / "harness.log").open("w", encoding="utf-8", newline="\n") as log:
            last_activity = -1.0
            for line in child.stdout:
                log.write(redact(line))
                log.flush()
                # A bounded activity signal; upstream output can contain prompts.
                # Keep the text in the existing evidence file, not the live preview.
                now = time.monotonic()
                if now - last_activity >= 0.2:
                    last_activity = now
                    sys.stdout.write(json.dumps({"schemaVersion": 1, "type": "activity", "message": "AgentX: harness output received"}) + "\n")
                    sys.stdout.flush()
        code = child.wait()
        telemetry.finish()
        # The official exporter redacts keys and headers. Also sanitize exact
        # runtime secrets in textual evidence, including error-path exports.
        for path in artifacts.rglob("*"):
            if path.is_file() and path.suffix in {".json", ".jsonl", ".yaml", ".yml", ".txt", ".log", ".csv"}:
                # Per-request JSONL can be large; never load a whole trace export.
                temporary = path.with_name(path.name + ".redacting")
                try:
                    with path.open(encoding="utf-8", newline="") as source, temporary.open("w", encoding="utf-8", newline="") as target:
                        for line in source:
                            target.write(redact(line))
                    temporary.replace(path)
                finally:
                    temporary.unlink(missing_ok=True)
        coverage = None
        if expected is not None:
            from replay_coverage import audit_replay
            coverage, traces = audit_replay(expected, list(artifacts.rglob("profile_export.jsonl")))
            evidence = json.dumps({**coverage, "traces": traces}, indent=2) + "\n"
            (artifacts / "replay-coverage.json").write_text(evidence, encoding="utf-8")
            (output / "replay-coverage.json").write_text(evidence, encoding="utf-8")
        if code != 0:
            raise RuntimeError("AgentX Harness exited with code %s; see agentx/harness.log" % code)
        if coverage is not None and not coverage["complete"]:
            raise RuntimeError("AgentX full trace replay is incomplete; see replay-coverage.json")
        exports = list(artifacts.rglob("profile_export_aiperf.json"))
        if len(exports) != 1:
            raise RuntimeError("AgentX must produce exactly one profile_export_aiperf.json")
        raw = json.loads(exports[0].read_text(encoding="utf-8"))
        if raw.get("was_cancelled") is not False:
            raise RuntimeError("AgentX profiling was cancelled")
        terminal = {"schemaVersion": 1, "type": "result", "export": raw}
        if network is not None and network["mode"] == "automatic":
            # Keep official RTT and adjusted metrics untouched. Only count the
            # raw probe records so unavailable/failed probing remains visible.
            files = list(artifacts.rglob("profile_export_network_latency.jsonl"))
            probes = None
            if len(files) == 1:
                probes = {"total": 0, "successful": 0, "failed": 0}
                with files[0].open(encoding="utf-8") as stream:
                    for line in stream:
                        if not line.strip():
                            continue
                        sample = json.loads(line)
                        probes["total"] += 1
                        probes["successful" if sample["success"] and sample.get("rtt_ns") is not None else "failed"] += 1
            terminal["networkLatencyProbes"] = probes
        if request.get("telemetry"):
            from server_metrics import read_server_metrics
            terminal["telemetry"] = read_server_metrics(artifacts, telemetry.sources)
            if request.get("telemetry", {}).get("ascend", {}).get("mode") == "local":
                terminal["telemetry"]["localAscend"] = telemetry.evidence()
        if coverage is not None:
            terminal["replayCoverage"] = coverage
        print(redact(json.dumps(terminal)), flush=True)
        status = "completed"
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        event("end", {"status": status})


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--harness":
        launch_harness()
    else:
        try:
            run()
        except (Exception, KeyboardInterrupt) as error:
            # Do not echo exception details which may contain provider secrets.
            print(json.dumps({"schemaVersion": 1, "type": "error", "message": type(error).__name__ + ": AgentX run failed; see saved artifacts"}), flush=True)
            sys.exit(1)
