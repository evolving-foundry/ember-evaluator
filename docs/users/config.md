# Progressive Experiment Configuration

> English | [中文](./config.zh-CN.md)

Experiment YAML can declare only model services and a benchmark; plugin profiles fill remaining fields:

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark:
  name: workbuddy
  scenario: office
```

Use the [Office](../../playbook/workbuddy/workbuddy-office.yaml) or [DeepSWE](../../playbook/deepswe/deepswe.yaml) examples. DeepSWE defaults to 1.1; WorkBuddy defaults to code and supports code/office/web/security. Sources are pinned to existing Git revisions/archive digests. Unknown versions/scenarios fail.

See [Playbook](../../playbook/README.md) for production YAML and [benchmark guides](benchmarks/README.md) for versions, scoring, and requirements.

Terminal-Bench/SWE-bench Verified use `benchmark.name: terminalbench/swebench`, defaulting to 2.0/1.0. GSM8K, HumanEval, and MMLU profiles also supply cache defaults. YAML explicitly controls model budgets, task selection, judges, and custom solvers. Ray examples need scheduler.name: ray and concurrency only; without an address, actual runs prepare/use the managed local cluster.

See [Terminal-Bench](benchmarks/terminalbench.md) for versions, task images, and requirements.

![YAML expands through profiles and validation; bootstrap creates components through Cordis-registered factories](imgs/02-framework-config-plugins.png)

`loadConfig` fills configuration from registered profiles; `bootstrap` selects factories by component names. Authentication is service-bound; saved configuration retains references only. Registration/validation start no tasks.

## NPU and GPU Selection

Select hardware at the experiment YAML root:

```yaml
hardware: npu # npu or gpu; defaults to npu
```

User YAML overrides profile defaults; the framework default is NPU. `inspect`, saved configurations, and Ray workers carry the effective choice. This setting does not detect devices, start or switch remote model servers, or port CUDA tasks to NPU. Tasks without accelerator requirements behave the same under either choice.

| Scenario | `npu` | `gpu` |
| --- | --- | --- |
| AgentX API replay and vLLM metrics | Supported | Supported |
| AgentX `telemetry.ascend` | Ascend collection | Configuration conflict before execution |
| Kernel precision, timing, profiling | NPU implementation | GPU backend not implemented; rejected before execution |
| Harbor task requiring GPU | Hardware mismatch | GPU task execution not implemented |

Model API calls do not require accelerators on the Evaluator host. GPU hardware telemetry and task device mounting are not supported. Incompatible tasks fail according to `run.onError`; their requirements are neither silently skipped nor rewritten.

Historical configurations without this field mean NPU. Omitted hardware and explicit `npu` retain the same resume configuration fingerprint; changing to `gpu` requires a new run. Existing source and plugin version checks still apply. Offline reports do not access hardware.

## Names and Defaults

| Name | Decision | Examples |
| --- | --- | --- |
| Benchmark | Questions or load to evaluate | `gsm8k`, `workbuddy`, `agentx` |
| Solver | Task executor | `simpleagent`, `agentbundle`, `agentx-replay` |
| services | Model name, endpoint, authentication variable | `services.default`, `services.judge` |
| environment | Agent execution location | Host `local` or isolated `docker` |
| scheduler | Concurrent task count and Ray use | `local`, `ray` |

A benchmark profile supplies defaults. WorkBuddy `office`, for example, supplies sources, verifiers, and budgets. Start with defaults and override as needed; `inspect` shows final values.

Defaults: Docker Environment, Local Scheduler concurrency 1, Local Store, Markdown Reporter. Omitted `output`/`output.directory` uses repository-root `results/<benchmark-name>/<YAML-basename>/<runId>/`. `playbook/gsm8k/gsm8k-agentbundle.yaml` maps to `results/gsm8k/gsm8k-agentbundle/<runId>/`. Names come from configuration; all WorkBuddy scenarios use workbuddy. This default is independent of YAML/current directories; installed packages use the Evaluator package root.

Explicit `output.directory` overrides the location; relative values use the YAML directory. Keep original output settings for resume. Resolved/saved configurations record actual output paths, so file renaming does not regenerate them. Harbor defaults to system user cache, overridable by EVALUATOR_CACHE_DIR or benchmark.config.cacheDir. Security needs native Linux paths, not Windows or /mnt/c,/mnt/d.

Local defaults to readiness pipelines, with preparation concurrency following `scheduler.concurrency`. Tasks start when solve/verify dependencies and execution slots are ready. Use `run.preparation.mode: batch` to wait for all, or `run.preparation.concurrency` for a separate cap. Ray retains batch; AgentX profiles retain serial batch. See [concurrency](concurrency.md).

Components accept strings such as `reporter: markdown`, `metrics: [harbor-score, success-rate, duration, usage]`, or full `{ name, config }`. Environment platform and Scheduler concurrency/nodes may be flattened; duplicating fields in config fails. Changing plugin names clears previous implementation-specific settings.

All tasks run by default; individual failures continue (`onError: continue`). Resume with `run experiment.yaml --resume [run-id]`. Configuration uses `services` and one `benchmark`; legacy `benchmarks` arrays/top-level `model` or `solver` are rejected.

## Add Options as Needed

```yaml
benchmark:
  name: deepswe
  version: "1.1"
  solver:
    name: agentbundle
    # service: default
    config:
      path: ./bundles/dsh-deepswe

environment:
  platform: linux/amd64

scheduler:
  concurrency: 8

run:
  taskIds:
    - fastapi-deprecation-response-headers
  timeoutSeconds: 18000

output:
  directory: ./results/my-experiment
```

Combine these fragments with services. Solver defaults to simpleagent; AgentBundle is a Solver plugin requiring a prepared bundle path. Service selection prefers services.default, then the sole service; otherwise set solver.service. Model API defaults to openai-completions; harness/services manage budgets.

### Whole-Task and Phase Timeouts

```yaml
run:
  timeoutSeconds: 7200        # Whole-task cap in seconds
  solveTimeoutSeconds: 3600   # Optional solve-phase cap
  verifyTimeoutSeconds: 600   # Optional verification-phase cap
```

`run.timeoutSeconds` is the whole-attempt cap, defaulting to 7200 seconds (two hours). Explicit profile/YAML values take precedence; existing explicit example values are not rewritten.

Solving/scoring use explicit `run.solveTimeoutSeconds`/`run.verifyTimeoutSeconds`, then task `agent.timeout_sec`/`verifier.timeout_sec`. If both corresponding values are absent, only the whole-task cap applies. New fields are optional positive integers; omission retains task declarations. `0`, `null`, and negatives do not disable limits.

Whole-task/phase clocks run simultaneously; the first expiration stops execution. Phase timing begins on phase entry; a longer phase does not extend the whole-task cap. Early preparation and cleanup have separate budgets below.

Old `benchmark.config.defaults.verifyTimeoutSeconds` is removed; use `run.verifyTimeoutSeconds`, without automatic migration/compatibility. Update Ray coordinator, workers, and Jobs packages together to preserve phase settings.

Configure download sources, proxies and image acquisition with a separate [network YAML](network.md), selected by `--network`.

Pi/SimpleAgent and built-in judges with explicit OpenAI Chat Completions `base_url` send `services.<service>.maxTokens` only when configured. Omission sends neither `max_tokens` nor `max_completion_tokens`; the API decides. SDK model budgets still manage local context without hidden output caps. Registered providers retain SDK protocol defaults; external agents retain their own mechanisms.

Pi local budgets prefer explicit `maxTokens`, packaged [model defaults](../../src/runtimes/pi/model-defaults.json), registered model settings, then `128000`. Defaults match model ID or `provider/model-ID`, preferring the latter, and participate in runtime digests. Server output/context limits may still truncate. Evaluator preserves actual termination reasons rather than accepting truncated output as valid scoring.

### Environment Preparation Timeouts

```yaml
run:
  preparation:
    concurrency: 8
    environmentTimeoutSeconds: 600 # Optional per-environment base at concurrency 1
    # roundTimeoutSeconds: 7200    # Optional round cap, not multiplied by concurrency
```

Each solve/verify environment times actual preparation using `base × min(effective concurrency, 10)`, excluding queueing/ready waits. Local uses min(preparation concurrency, pending count); Ray also caps by node slots rather than cluster concurrency. The multiplier is fixed after round allocation and does not shrink for tail tasks.

Base precedence: explicit `run.preparation.environmentTimeoutSeconds`, task environment declaration, benchmark default. Harbor retains separate solve/verify `build_timeout_sec`, then `defaults.buildTimeoutSeconds`. Record defaults are 600 seconds; OfficeQA/AgentX 3600. Verification image/runtime share their phase budget; runtime-only verification still has a limit. Both new options accept finite positive seconds, remain absent when omitted, and must fit Node timer milliseconds.

No round cap applies by default. Explicit `roundTimeoutSeconds` measures wall time for Local batch/Ray; Local pipeline counts preparation-active time, pausing during execution-only waits but including network/build waits. It is not multiplied. External plugins without `planRun()` create no rounds; attempt preparation remains within whole-task budgets. Per-environment preparation uses the same multiplier and accumulated preparation busy time.

Timeout saves `ENV_PREPARATION_TIMEOUT` without scores or automatic retries. `onError: continue` permits other tasks; cleanup/storage may still stop work. Base 600/concurrency 32 allows 6000 seconds; base 1800 allows18000. Reduce base or set a round cap to shorten waits.

Old `benchmark.config.environmentBuildTimeoutMultiplier` is removed and cannot compound. Remove it; use `roundTimeoutSeconds` for round caps or `environmentTimeoutSeconds` for base values. Configuration identity checks after profile expansion remain. After upgrades, start new runs if configurations differ or resume with the original configuration; do not edit old manifests. Evaluator code may be updated and rebuilt before resuming. Historical batch budgets retain their meaning and are not interpreted as per-environment limits offline.

## Task Offset and Count

`run.offset` is a nonnegative safe integer skipping initial tasks; omitted/0 starts first. `run.maxTasks` is a positive integer limit; omitted/null runs all remaining tasks. Example: run questions 11–15:

```yaml
run:
  offset: 10
  maxTasks: 5
```

Default selection follows enumeration order. `run.taskIds` filters candidates while retaining source order; `run.sampling: { strategy: random, seed: 42 }` then shuffles deterministically. Apply `offset`, then maxTasks. Omit taskIds/sampling for contiguous original positions.

Fewer remaining tasks runs the remainder; `offset` at/beyond candidate count fails as empty. CLI/SDK support both fields; dry-run uses identical selection and prints IDs. Resume retains original offset/selection. CLI `--task-ids-file` replaces YAML selection, ignoring YAML offset/maxTasks/sampling.

## Gated Hugging Face Authentication

GPQA uses gated [Idavidrein/gpqa](https://huggingface.co/datasets/Idavidrein/gpqa); OfficeQA Pro V2 also requires access approval. Accept dataset conditions with your HF account, obtain access, then create a read-authorized [User Access Token](https://huggingface.co/settings/tokens). Tokens do not replace approval; model keys are not HF_TOKEN.

Reference environment variables directly in YAML, or supply SDK `env`. GPQA example; see [full configuration](../../playbook/gpqa/gpqa-simpleagent.yaml):

```yaml
benchmark:
  name: gpqa
  config:
    hfToken: ${HF_TOKEN}
```

Ten HF record benchmarks (gsm8k, mmlu, mmlu_pro, math500, gpqa, mgsm, triviaqa, humaneval, simpleqa, healthbench), OfficeQA Pro V2, and AgentX support `benchmark.config.hfToken`. DROP downloads official AllenAI archives directly, supports cacheDir only, and uses no hfToken. Old `hfTokenEnv` is rejected. Omit authentication for public data to avoid required variables; GPQA/OfficeQA examples declare it explicitly.

AgentX traces are public and existing examples require no extra HF_TOKEN. Prepare a matching tokenizer alongside inference services and provide its local path through existing tokenizer fields, without new authentication options. Current WorkBuddy public archives need no HF token.

Saved/exported configuration keeps variable references, never expanded tokens. Ray messages/Jobs retry files strip explicit credentials; nodes use their own HF_TOKEN, also available when hfToken is omitted. Local `hf auth login` caches are not read automatically. WSL can prompt interactively to avoid shell history:

```bash
read -rsp 'HF token: ' HF_TOKEN
printf '\n'
export HF_TOKEN
```

Alternatively, read a token-only UTF-8 Windows file in WSL, e.g. `export HF_TOKEN="$(cat /mnt/c/Users/your-name/Desktop/hf_token.txt)"`. Keep values out of YAML, arguments, chats, and results. Other names may be referenced as `hfToken: ${DATASET_TOKEN}`; Ray still requires HF_TOKEN. Prefer official `HF_ENDPOINT=https://huggingface.co` for authenticated requests; gated mirror support varies. See [HF gated datasets](https://huggingface.co/docs/hub/datasets-gated).

## Local Model Services and Docker

On native Linux Docker, including standalone WSL daemons, host/container `127.0.0.1` are different namespaces. Host loopback endpoints map to `host.docker.internal`, a host gateway alias that does not expose services bound only to loopback.

Bind local LiteLLM/services to a Docker-private-bridge-accessible address or add a bridge-only forwarder. Keep loopback separately if needed. Preflight the actual path using the real Solver image, mapped endpoint, and harness. Host CLI success alone does not prove container access. For connection failure with zero usage, inspect bind addresses, gateway mapping, and proxy bypass.

## Verifiers and Judge Models

DeepSWE/Security use shell verification; Code uses upstream program scoring; Office defaults to model scoring off. Enable Office with services.judge and `benchmark.verifier: { service: judge }`.

Web requires a judge; minimal configuration binds the default service. Add services.judge and verifier.service for independence. Verifiers receive bound model, endpoint, and authentication. Advanced implementations replace benchmark.verifier.name/config.

Default metrics: harbor-score, success-rate, duration, usage; DeepSWE adds f2p/p2p/partial. deepswe-score/workbuddy-score are profile aliases expanded to harbor-score in saved configuration.

## Inspect Effective Configuration

```bash
ember-evaluator inspect experiment.yaml
ember-evaluator inspect experiment.yaml --patch ./patch.yaml
```

`inspect` prints JSON containing the effective experiment and network settings, with credential references preserved. It validates configuration without factories, downloads, task enumeration, containers, or model calls. Model settings come from YAML; model override flags are supported only by run.

Precedence: framework defaults, parent profile, version/scenario profile, YAML, CLI. Objects merge recursively; arrays replace wholesale. Origin metadata is excluded from fingerprints; equivalent shorthand/full forms match. Results save internal execution configuration; offline reports/user YAML have separate readers. Resume allows updated Evaluator code while configuration, sources, external plugins, and solver identity must still match; see [resume](usage.md#resume-and-rebuild-reports).

## Ray and Execution Nodes

![Ray coordinator dispatches tasks; nodes upload evidence over HTTPS for manifest verification and Store import](imgs/07-flowchart-ray-execution-v2.png)

Coordinator patch paths are not sent as node-readable files. Nodes use preinstalled plugins/authentication and validate package/plugin/patch digests. Upload receipts confirm results without requiring shared storage.

Ray transfers configuration by component declarations, not benchmark names. Built-in record/Harbor `cacheDir` is removed; nodes use `outputRoot` `cache/<role>/<name>`, Jobs coordinators use the same under EVALUATOR_JOBS_ROOT. Declared `dockerExecutable` comes from node settings or component defaults. Local retains experiment values. See [plugin transport declarations](../development/plugins.en.md#transfer-component-configuration-to-ray-nodes). Container workdirs transfer only at explicitly declared positions. Harbor local sources cannot be directly distributed.

For the managed local cluster, add:

```yaml
scheduler:
  name: ray
  concurrency: 4
```

Without addresses/deployment, Ray Jobs local parameters are filled and actual runs prepare the cluster. Configuration inspection does not start it. Omitting scheduler still uses Local without Ray.

For an existing remote cluster, supply:

```yaml
deployment:
  kind: ray-jobs
  endpoint: https://your-head:9443
  caFile: ./cluster-ca.pem
  tokenEnv: EVALUATOR_JOBS_TOKEN
  managedLocal: false
scheduler:
  name: ray
  concurrency: 25
  nodes: 2
```

The outer run submits whole experiments through deployment; submitters create no local Environment/Solver/Store. Remote coordinators load internal config and create Ray TaskScheduler without redeploying. CA, gateway authentication, managedLocal belong to deployment; nodes/concurrency belong to scheduler. URL schemes do not implicitly select connection modes.

Explicit deployment defaults managedLocal to false, connecting existing clusters; true prepares the managed cluster. Without deployment/Ray Client endpoint, shorthand fills kind: ray-jobs and managedLocal: true. Remote deployment installs no plugins automatically. nodes selects existing nodes without deploying/scaling; placement, preparation, execution, and cleanup share capacity rules.

With explicit scheduler.config.endpoint and no deployment, the current process runs Engine and connects through Ray Client:

```yaml
scheduler:
  name: ray
  concurrency: 4
  config:
    endpoint: ray://your-head:10001
    collector:
      host: 0.0.0.0
      certFile: ./collector-cert.pem
      keyFile: ./collector-key.pem
      publicUrl: https://your-coordinator
      tokenEnv: EVALUATOR_TRANSFER_TOKEN
```

## Discovery, Initialization, and Diagnostics

benchmark list/info read registration/profiles without factories. init --benchmark `<name>` --output `<yaml>` writes minimal new YAML with wx and never overwrites. benchmark list/info, init, inspect, and doctor accept explicit --patch.

doctor `<yaml>` shares production configuration/composition validation, checks Docker/Python, local paths, and Ray connectivity. It performs temporary downloads and Docker build probes without sending model requests or executing tasks. Results are passed, failed, or not-checked. Local connectivity proves neither remote node readiness nor model permissions. Exit: discovered failure1, configuration2, cancellation130.

--dry-run resolves sources, checks caches, downloads as needed, and enumerates selected IDs; its side effects differ from doctor.

## Record-Based Model Judges

SimpleQA/HealthBench explicitly select a services entry with benchmark.config.judgeService, without automatically reusing the evaluated model. Even reuse requires an explicit service name. init generates judge placeholders. See [scoring](reference/scoring.md) for rules/custom protocol boundaries.

Plugin authors: see [profile publication](../development/benchmarks.en.md#publish-default-profiles).

## Network Failure Recovery

`ember-evaluator retry --run <run-id>` creates attempts for current network failures in the original run. Valid zeros, ordinary phase timeouts, and non-network errors are ineligible. Network operations retry within their own bounds rather than whole tasks; each manual request may add one eligible attempt. Removed `run.taskRetry` must be deleted from old YAML. Ray Jobs connects the original gateway through separate `deployment`, not a Scheduler plugin. See [network recovery](network-retry.md).

[User guide](README.md) · [Quick start](quick-start.md)
