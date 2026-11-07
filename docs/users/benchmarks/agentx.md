# AgentX Performance Evaluation

> English | [中文](./agentx.zh-CN.md)

AgentX reconstructs request lengths, prefix reuse, session turns, subagent dependencies, and waits from redacted traces to measure throughput/latency. It has no ground truth: `passed` is `null`, with no accuracy/reward. Implementation pins [agentx-harness1.0.7](https://inferencex.semianalysis.com/agentx/quickstart), scenario `agentx`.

![AgentX replays pinned traces per measurement point through a Python harness and exports performance summaries](../imgs/09-flowchart-agentx-performance-v2.png)

Concurrency has two meanings: outer Scheduler executes one point at a time; load concurrency counts active session trees inside it. Subagents may increase request concurrency, so tree count differs from simultaneous requests. Summaries feed performance reports without quality scores.

## Hardware Selection

Top-level `hardware: npu` (the default) selects existing NPU behavior. With `hardware: gpu`, API replay and `telemetry.vllm` remain available without a GPU on the replay host. `telemetry.ascend` conflicts with GPU selection and is rejected before sampling by `doctor`, dry runs, and execution. GPU hardware metrics are not supported. See [configuration](../config.md#npu-and-gpu-selection) for defaults and resume behavior.

The [GPU service API example](../../../playbook/agentx/agentx-gpu-api.yaml) replays requests without collecting device metrics.

## Preparation and Execution

Prefer `environment: local`. Replay calls APIs from Evaluator's environment without executing real trace tools or creating task images/containers. Run inside toolbox or directly on the host. Users start inference services manually; Evaluator neither starts nor stops them.

Management images include Python/venv/compiler dependencies; first use creates an isolated cached AgentX venv for reuse. Direct local use needs Python 3.11–3.13/venv, selectable via `pythonExecutable` or PYTHON_BIN. Only the venv receives harness installation; no global Python/system packages change. Explicit `environment: docker` prepares independent task containers if required.

Services need streaming OpenAI Chat Completions, `ignore_eos`, and trace output lengths. Default official 062126 256k corpus requires at least 256k context plus headroom. `full` targets approximately1M context. Traces are not truncated for smaller contexts.

Follow [quick start](../quick-start/agentx.md) for installation, model variables, tokenizer, and doctor/dry-run/run commands. This guide defines loads, metrics, and telemetry. `doctor` performs download probes without inference; dry-run may download and lists points.

Choose a configuration for your goal; running all in sequence is unnecessary:

| Goal | Configuration |
| --- | --- |
| Standard windows/concurrency sweep | [agentx-standard.yaml](../../../playbook/agentx/agentx-standard.yaml) |
| Online API, request/replay metrics only | [agentx-model-api.yaml](../../../playbook/agentx/agentx-model-api.yaml), no telemetry |
| Docker standard with automatic host NPU sampling | [agentx-npu-docker.yaml](../../../playbook/agentx/agentx-npu-docker.yaml) |
| Full first 50 traces, potentially long | [agentx-replay.yaml](../../../playbook/agentx/agentx-replay.yaml) |
| Two traces plus vLLM/NPU4 metrics | [agentx-npu-replay.yaml](../../../playbook/agentx/agentx-npu-replay.yaml), two endpoints required |
| local standard with selected host NPUs | [agentx-npu-local.yaml](../../../playbook/agentx/agentx-npu-local.yaml), toolbox/direct host, explicitly list each card |

### Model Variables for Local Services and Online APIs

| Variable | Self-hosted inference | Online API |
| --- | --- | --- |
| `MODEL_NAME` | `/v1/models` ID, including startup aliases | Provider model ID |
| `MODEL_ENDPOINT` | OpenAI-compatible base such as `http://127.0.0.1:8000/v1` | Provider base such as `https://api.example.com/v1`, not web chat |
| `MODEL_API_KEY` | Service key; `EMPTY` if unauthenticated | Valid provider key |

See [quick-start configurations](../quick-start/agentx.md#2-configure-yaml-and-model-variables) for exports. Start self-hosted inference manually; enable telemetry only with monitoring access. NPU sampling reads specified hardware on Evaluator's host, not remote model machines.

Use [online YAML](../../../playbook/agentx/agentx-model-api.yaml) without telemetry. It measures client request/replay behavior, **not server engine or GPU/NPU metrics**, and substitutes no local hardware data. OpenAI compatibility alone does not establish streaming/ignore_eos/context/output compatibility.

`MODEL_ENDPOINT` accepts an origin, `/v1` base, or full `/chat/completions` URL. Model aliases/provider IDs may differ from `tokenizer` repositories. Specify a matching HF `org/repo` or tokenizer-only directory; Docker uploads it. Old `AGENTX_TOKENIZER` is simply variable interpolation for that field. Omitted `tokenizer` or `${MODEL_NAME}` uses model ID, valid only when it also names a `tokenizer` repository.

Initial downloads include traces, tokenizers, and Python dependencies, adding wall time beyond measurement. `HF_ENDPOINT` follows [data settings](../config.md); `HF_TOKEN` supports restricted tokenizers; `PIP_INDEX_URL` selects Python mirrors.

Traces are public; existing examples need no extra HF_TOKEN. For explicit data credentials set `benchmark.config.hfToken: ${HF_TOKEN}`, including SDK `env`; omission uses process HF_TOKEN. Old hfTokenEnv is rejected. Prepare tokenizers with inference services and supply existing local-directory fields, without extra tokenizer authentication options.

## Concurrency and Configuration

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: agentx
  scenario: standard
  config:
    variant: 256k
    concurrency: [1, 4, 8]
  solver:
    config:
      tokenizer: ${MODEL_NAME} # Use a matching tokenizer if the alias/API model ID is not a repository name
      trustRemoteCode: false
environment: local
```

`concurrency` counts harness-managed session trees; subagents can increase HTTP concurrency. Evaluator scheduling must be 1, running points sequentially to avoid contention. run.maxTasks/taskIds/sampling select points, not requests within traces.

standard defaults to 3600 seconds. Set a positive integer benchmark.config.durationSeconds per point, for example60:

```yaml
benchmark:
  name: agentx
  config:
    durationSeconds: 60
    concurrency: [1, 4, 8]
```

Seed remains 42 with the 0.25–0.75 starting window, official warmup, and original waits. Non3600 durations pass `--unsafe-override`, preserve upstream validity, and locally mark `comparable: false` with custom_duration. They are not comparable formal one-hour scores.

`durationSeconds` excludes preparation/warmup/teardown;60 does not bound the whole command. Default task budget is 10800 seconds and need not change for 60. Total must be at least `durationSeconds + 3900`; increase `run.timeoutSeconds` for longer windows. Insufficient budgets fail before execution.

`replay` completes the first N traces, requiring explicit traceCount. The example uses first 50 sessions, tree concurrency 8, and starts at request0, finishing all main/subagent requests. It retains official reconstruction/dependencies/waits, disables extra single-token warmup, and profiles every request. Startup/drain make it incomparable to one-hour standard. `durationSeconds` defaults 86400 as a safety cap; task budget 172800. Early caps, missing/duplicate/cancelled requests fail points with partial artifacts; resume reruns whole points. Concurrency cannot exceed selected sessions.

Replay safety caps permit early completion of finite requests. Source-request coordinate coverage replaces standard fixed-window duration coverage. Harness still exports actual windows/metrics. Replay remains incomparable; standard retains official time-window checks.

Few traces may still take hours due to dozens of main requests, branches, and original waits. Harness1.0.7 skips some waits only during global idleness, not per-request delays. Two traces with600-second caps can fail despite successful requests if source dispatch is incomplete. Inspect `harness.log` `timeout_triggered`, branch counts, replay-coverage.json. Distinguish safety deadlines from request/branch bugs; increase budgets while retaining original loads rather than deleting waits/branches.

Solver accepts `tokenizerRevision`, `requestTimeoutSeconds`, `trustRemoteCode`, and `networkLatency` below. Tokenizers resolve to commits/digests; resume validates/reuses them. `trustRemoteCode` defaults false. Traces control output lengths; do not set services.maxTokens. Supported scope: `agentx-replay`, local scheduling, local/Docker, one automatic attempt; no Ray, ordinary agent Solver, or correctness Verifier.

### Network Latency Calibration

Add `networkLatency` under `benchmark.solver.config` for official harness RTT calibration. Omission disables it without changing raw metrics/load. local/Docker support probes from the harness environment to the actual endpoint. doctor/dry-run never probe.

Automatic TCP handshake RTT:

```yaml
benchmark:
  name: agentx
  solver:
    config:
      networkLatency:
        mode: automatic
        pingIntervalSeconds: 1 # Optional, default 1 second; must be positive
```

For known mean RTT, use manual milliseconds:

```yaml
networkLatency: # Under benchmark.solver.config
  mode: manual
  meanMs: 5
```

`meanMs` must be finite/nonnegative. Manual mode performs no TCP probes and disallows `pingIntervalSeconds`; automatic disallows meanMs. Unknown or mixed-mode fields fail before execution.

Results appear in `result.json` `solve.observations.networkLatency`, `agent/agentx-summary.json`, and metrics.json. Reports show mode, deducted mean RTT, total/success/failed probes, and raw/adjusted TTFT, TTFO, request latency (mean/P50/P95/P99). Adjusted distributions come directly from official `network_adjusted_*` exports, without recomputation. ITL/throughput/existing comparisons retain raw metrics.

`complete` means usable RTT and adjusted metrics. Failed/missing probes or missing adjusted metrics yield `partial` with data/warnings retained; no usable RTT/adjusted values yields unavailable. Missing values show `—`, never0. Calibration absence does not replace request success/failure. Pinned harness manual `meanMs: 0` may export no adjusted metrics; report `unavailable` while retaining raw values.

Automatic probes are saved in `profile_export_network_latency.jsonl` inside `artifacts/artifacts.tar`; manual mode has no probe file. Historical results without calibration still report. Offline `report` reads saved data without probes/model access.

Mean TCP RTT estimates network round trips only, not every proxy/transport/client overhead, nor actual throughput/session impacts. See [official calibration definitions](https://github.com/SemiAnalysisAI/agentx-harness/blob/master/docs/metrics-reference.md#network-latency-calibration-metrics).

## Results, Resume, and Offline Reports

Each concurrency point has a separate attempt saving:

- `agent/agentx-summary.json`: versioned summary also in solve.observations.
- `agent/trajectory.jsonl`, `session.jsonl`, and redacted bridge logs.
- `artifacts/artifacts.tar`: raw harness exports/logs under `agentx-artifacts`, with collectable partial artifacts on failure.
- replay also saves `agent/replay-coverage.json`, checking trace IDs/original outer-inner coordinates, also included in raw artifacts. Reports count completed traces, captured requests, failures, cancellations, missing/duplicate requests.

Profiling/warmup are separate. TTFT/ITL/request latency/Interactivity distributions come from official exports; throughput uses harness measurement time. Point percentiles are not merged. Missing values stay unknown; token usage sums only fields available for both warmup/profiling, not provider bills.

For multiple points, root `report.md` lists status and report links. `[1, 4, 8]` creates `points/c1/report.md`, `points/c4/report.md`, `points/c8/report.md`, each with metrics.json. Each contains only its request/warmup/vLLM/device-chip metrics, duration, usage, and attempts, including failure/unrun status pages. A single point retains detailed root report.md.

Root `metrics.json` keeps batch machine data/subreport indexes. Point metrics recalculate from their own records. Raw links point to original attempts without copying trajectories/artifacts. Points share run ID/source lock/resume state and execute sequentially.

`upstreamSubmissionValid` preserves harness judgment; `comparable` additionally checks scenario/source/completeness. Compare identical corpus commits, scenario, tokenizer, concurrency, and deployment. Completed replay does not establish leaderboard eligibility.

```bash
ember-evaluator run playbook/agentx/agentx-standard.yaml --resume
ember-evaluator report results/agentx-standard/RUN_ID
```

Completed points skip; failed/cancelled/timed-out points get full new attempts, not request continuation. Performance timeouts are not zeros. `report` rebuilds indexes/point reports and repairs missing/corrupt subreports from saved data/built-in plugins, without Python/model credentials/cache. Explicit resume writes `reports/resume-N/` and preserves prior reports; retry/offline `report` update current reports. See [report storage](../usage.md#resume-and-rebuild-reports).

## vLLM and Ascend NPU Metrics

`benchmark.solver.config.telemetry` separately enables vLLM/Ascend. Omission measures sessions only without monitoring probes/device tools. Harness collects Prometheus and aggregates profiling/warmup; Evaluator saves/displays each source.

Monitoring applies to self-hosted services with access. Online APIs omit telemetry and cannot provide server engine/hardware metrics; model responses are not Prometheus endpoints.

On the same NPU server with `environment: local`, automatic host sampling needs no prestarted ascend_metrics.py. Toolbox uses its host channel; direct hosts start Python children without toolbox. Configure existing `benchmark.solver.config`:

```yaml
telemetry:
  vllm:
    endpoint: http://127.0.0.1:8000/metrics
  ascend:
    mode: local
    devices:
      - deviceId: 0
      - deviceId: 1
```

Use actual inference `npu-smi` IDs, not other devices. Without `chipId`, `npu-smi info -m` discovers compute chips excluding MCU. Set `{ deviceId: 0, chipId: 0 }` to select one. Lists must be nonempty/unique. Physical IDs may differ from logical model IDs.

Each point creates an ephemeral loopback endpoint before harness startup, covering warmup/profiling, and closes sampling/ports on completion/failure/timeout/cancellation. Host needs Python 3.9+ and `npu-smi` in PATH. Chip queries are separate, bounded, read-only. Card failures preserve other cards/session data with per-card diagnostics, not zero substitution.

toolbox/run.sh prepares token-authenticated host control, querying only when `run` selects cards. local/Docker prefer it; without one only direct-host standard-library Python children are allowed. Missing container channels fail `doctor` and mark sampling unavailable at runtime rather than querying inside. `doctor` checks channels/programs without devices; dry-run starts no sampling. Toolbox maps no NPU and needs no npu-smi installation.

With `environment: docker`, the harness uses task containers while sampling remains on Docker hosts. Explicit host networking reaches model/loopback metrics. Task containers also map no NPUs. Samplers expose no model startup/arbitrary shell interface.

Host sampling allows only `npu-smi info -m` and selected device/chip info -t usages|memory|power|temp. It never runs set, changes device-share, installs packages, edits system files, or maps devices. Control/diagnostics stay in the workspace. See [Docker example](../../../playbook/agentx/agentx-npu-docker.yaml); no manual sampler, extra container, or SSH worker is needed.

Use [local Ascend standard](../../../playbook/agentx/agentx-npu-local.yaml). Start vLLM, set model variables, matching tokenizer, vllm.endpoint/device IDs, then doctor/dry-run/run. First two start no device sampling. InfraAgent can `run` the same CLI through existing SSH workers, adding sampling YAML without separate services/ports.

Existing external samplers retain `endpoint` configuration, mutually exclusive with mode:local/devices. Evaluator scrapes without starting/stopping them:

```yaml
benchmark:
  name: agentx
  scenario: replay
  config:
    traceCount: 2
    concurrency: [1]
  solver:
    config:
      tokenizer: ${AGENTX_TOKENIZER}
      requestTimeoutSeconds: 1800
      telemetry:
        vllm:
          endpoint: http://127.0.0.1:18094/metrics
        ascend:
          endpoint: http://127.0.0.1:18095/metrics
          deviceId: 4
          chipId: 0
```

Use [two Ascend traces](../../../playbook/agentx/agentx-npu-replay.yaml) with `VLLM_METRICS_ENDPOINT` and ASCEND_METRICS_ENDPOINT. Both must be full reachable HTTP(S) metrics URLs without username/password/query/authentication values. Docker localhost is container-local; arrange access explicitly.

Harness strips trailing slashes and appends `/metrics` when absent. Both sources may share an address while filtering metric/model/device labels separately.

vLLM uses `/metrics` for KV cache, running/waiting requests, preemptions, prefix queries/hits, and input/output tokens, matched explicitly by version. Counters show window deltas/rates rather than lifetime totals. Adjacent deltas accumulate in sample order, retaining restart resets. Model labels/endpoints/profiling/warmup are separate; the first in-window sample uses the previous sample as baseline.

Raw upstream JSON/JSONL remains intact. Reports use ordered counters; rates divide by last in-window timestamp minus baseline, blank if nonpositive. Excluded boundary samples can make counter totals differ from request tokens; counts lost between scrapes cannot be restored. Request counts never substitute for device counters.

Host samplers use existing Python 3/driver `npu-smi` without extra packages.

Optional SSH/remote Python workers may start host samplers, inject dynamic `ascend.endpoint`, and stop after CLI completion/failure/cancellation. Only standard-library Python/read-only npu-smi is needed, without installs/set. Management containers dispatch; task containers run AgentX. Neither maps NPUs; only inference containers do.

This older deployment is optional and unnecessary for ordinary CLI use. Endpoints must be task-reachable: host networking reaches host loopback; others need explicit addresses. To manage sampling independently, start:

```bash
python3 dist/runtimes/agentx/assets/ascend_metrics.py \
  --device-id 4 --chip-id 0 --host 127.0.0.1 --port 18095
```

The script queries usages/memory/power/temp with fixed -i4 -c0. Target interval 1 second runs four queries serially, so actual cadence depends on duration; command timeout 2 seconds by default. Adjust --interval/--command-timeout. Snapshot TTL=max(3×interval,4×timeout+interval), default 9 seconds, avoids premature expiry during queries. Failures/expired snapshots return 503 and recover after successful sampling without zeros. SIGTERM/SIGINT stops HTTP/sampling threads; active queries wait at most their timeout.

Hardware reports show NPU/AI Core utilization, HBM use/capacity/bandwidth, power/temperature per device/chip, without merging chip utilization into card utilization. HBM keeps npu-smi MB; exact used memory is not inferred from rounded percentages. Only manually started inference containers map cards. Use physical host IDs, not assumed container logical IDs.

Bind remote samplers to loopback and access through SSH forwarding, for example:

```bash
ssh -N -L 18094:127.0.0.1:18094 -L 18095:127.0.0.1:18095 user@server
```

SSH authentication belongs to deployment, not YAML. Models need full trace context/output; even small262144-context models require real single-card validation. Service startup, model install, and preflight are excluded from request metrics.

`agentx-summary.json` stores source status, labeled series, missing metrics, profiling/warmup windows, and sample counts. Counts mean distinct in-window upstream JSONL snapshots, not HTTP scrapes. Aggregation may extend to final sampling; reports show actual bounds. Raw server_metrics_export.json/.jsonl accompanies attempts. Temporary scrape failures wait for the next harness cycle without aborting requests or discarding monitoring. Missing data/required metrics remain explicit. Offline reports access no devices/endpoints.

New results use telemetry v2 with multiple devices/chips and empty endpoints after discovery failure. Historical v1 converts at read boundaries for offline processing, without rewriting originals. `local-telemetry.json` saves devices/chips/dynamic endpoints/errors. `complete` means required statistics exist, not every scrape succeeded; `partial` means missing data/metrics; `unavailable` means no usable statistics. Available-source diagnostics appear in optional warnings/reports. Monitoring status does not change `submission_valid` or request comparability.

Adapters store cumulative upstream collection errors as `evaluator_collection_error_count` in raw exports and optional `telemetry.collectionErrors` in summaries. This endpoint-total count appears once, is not assigned per source, and does not automatically mark all sources partial. Historical absence means unrecorded, not zero.

[User guide](../README.md) · [Quick start](../quick-start.md)
