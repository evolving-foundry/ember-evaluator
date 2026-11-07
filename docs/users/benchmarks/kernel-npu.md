# Evaluating Existing Kernels on NPU (kernel-npu)

> English | [Simplified Chinese](./kernel-npu.zh-CN.md)

`kernel` validates existing candidates on Ascend NPUs, returning correctness, reference/candidate duration, speedup, and optional detailed hardware profiling. `kernel-replay` submits fixed artifacts without generation, repair, or model calls. Standalone use needs Evaluator, inputs, and NPU runtime. RSI generates candidates through its Proposer and evaluates frozen artifacts through the full SDK. This protocol performs correctness/timing/profiling; optimizers handle source diagnostics, model bottleneck analysis, and edits.

## Hardware Selection

Use top-level `hardware: npu` in experiment YAML; omission also means NPU. `hardware: gpu` fails with “Kernel GPU backend is not implemented” before reading candidates or starting Python. Built-in timing uses only the NPU profiler and fails without an NPU instead of falling back to CUDA or CPU. The `kernel precision/bench/profile` commands remain NPU entry points. See the [existing kernel example](../../../playbook/kernel/existing.yaml).

## Environment and Execution

Prepare dependencies through [installation](../installation.md). pnpm downloads and builds the AgentBundle SDK from GitHub automatically; no sibling source repository is required. Built-in plugin imports need this dependency even when that Solver is not selected.

Requires Linux, NPU, CANN, torch, torch_npu, triton-ascend; detailed collection also pandas/NumPy/Jinja2. Use a verified operator-capable Python and load CANN first. Only `local` environment/scheduler, concurrency 1; no competing timing workloads on the device. Built-in workers verify, so no benchmark.verifier. Local workspaces do not isolate malicious Python; evaluate trusted code only.

```bash
export KERNEL_EVAL_PYTHON=/absolute/path/to/venv/bin/python
export KERNEL_MANIFEST=/absolute/path/to/cases/tasks.json
export KERNEL_EVAL_PLACEHOLDER=unused-local-evaluation
pnpm build
ember-evaluator run playbook/kernel/existing.yaml --dry-run
ember-evaluator run playbook/kernel/existing.yaml
```

Example services are required placeholders with unusable URLs. The loader requires `api_key` to reference a nonempty variable; set `KERNEL_EVAL_PLACEHOLDER` to the ordinary text above, never a real key. Model usage is zero; offline `report` needs no variable.

## Task Files

Manifest paths are relative to its directory and must list reference/candidate dependencies. Absolute paths/.. are invalid. Dependencies retain relative structure in verification workspaces. Candidates must be self-contained Python or depend only on listed public helpers.

Reference/candidate remain under `data/<manifest-relative-path>`; candidates are not renamed/moved out. Same-directory helpers, relative package imports, and root-based packages are supported when all .py/__init__.py `files` are listed. Both run in one Python process; use distinct helpers and explicit package paths.

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "operator-example",
      "problem": "problem.py",
      "candidate": "candidate.py",
      "files": ["input.py"],
      "referenceKind": "original-kernel",
      "outputIndices": [0]
    }
  ]
}
```

- `problem.py` supplies Model/get_inputs(), optionally get_init_inputs(). Reference calls `Model(*get_init_inputs())(*get_inputs())`, moved to NPU/eval.
- Candidates supply `kernel_function(*inputs)`. A strict task contract permits candidate input mutation with `inputUnmodified: false`; set `output.independent: false` when the output shares input storage. Outputs must still match the reference numerically and satisfy the contracted shape, dtype, device and layout. The task author must provide explicit parameters, weights, state and entry signatures; Evaluator does not infer them.
- Output equivalence is checked, not Inductor symbol substitution or full-model end-to-end regression.
- `referenceKind: pytorch` means trusted mathematical PyTorch reference; `original-kernel` establishes `original-kernel` equivalence, not independently proven math correctness. Authors choose according to source.
- Compare full nested tensor/list/tuple/dict/scalar outputs by default. Explicit `outputIndices` selects top-level list/tuple elements. For (tensor,tiling metadata...), `[0]` excludes non-computational metadata; retain all relevant multi-tensor indices.
- Fixed seeds call candidates twice each. Compare shape/dtype/device/value and finite tensors/nested floats. Reference NaN/Inf invalidates evaluation; candidate NaN/Inf fails correctness. Separate input copies preserve strides.

Source locks include SHA-256 for manifests, candidate/reference/dependencies, `precision.py`, `timing.py`, `strict.py`, `timing_evidence.py`, and `msprof_replay.py` (the msprof-attached operator replay). Changes require new runs; resume rejects them. Dependencies enter only after solving switches to verification; public Solver inputs exclude references.

## Strict Task Contracts and Audited Timing

A manifest task may provide `contract` with schemaVersion 1, caseId, input tensor contracts, output tensor contract, and inputUnmodified. Each tensor specifies shape, dtype (`float16`) and contiguous; output also specifies independent. Contracts are optional for existing manifests. Strict evaluation checks entry, shape, dtype, device, layout, output independence, input preservation and numerical equality twice per seed. Results contain the contract digest, per-check assessment, effective protocol and observed environment. Reference/infrastructure failures remain invalid evaluations; candidate failures remain candidate failures.

For example, add this `contract` to a task whose actual inputs and output match these shapes:

```json
{
  "schemaVersion": 1,
  "caseId": "operator-example",
  "inputs": [{ "shape": [2, 4], "dtype": "float16", "contiguous": true }],
  "output": { "shape": [2, 2, 2], "dtype": "float16", "contiguous": true, "independent": true },
  "inputUnmodified": true
}
```

A strict success requires every check to pass and observed identities for Python, torch, torch_npu, Triton, CANN, driver, device and visible devices. Missing environment identity invalidates measurement. `verdict.details.assessment` retains the checks and effective settings; the benchmark verifies them against the requested seeds, tolerances, warmup and repeat.

Strict timing uses schemaVersion 2 / `profiler-flow/v1` evidence and CPU-to-NPU flow associations to assign device kernels to profiler steps. Raw CSV Step Id values are retained, not rewritten or trusted as the sole association. The audit rejects incomplete/ambiguous evidence and excludes warmup steps. The reported iteration mean covers all device kernels, not host launch time. CSV and trace artifacts accompany timing results. Public SDK exports parse contracts, assessments and timing evidence, and audit each timing sample.

## Detailed Profiling

The NPU backend owns Python/msprof execution, device binding and cleanup. The benchmark owns task identity and verdict validation. Full evaluation (`operation: evaluate`, the default) can collect diagnostics after successful correctness/timing by enabling profiling. Independent `operation: profile` requires exactly one task, one seed, `profiling.enabled: true` and `cacheEnabled: false`; it skips precision/timing and returns a performance result with no candidate score.

```yaml
benchmark:
  name: kernel
  config:
    operation: profile
    manifest: ${KERNEL_MANIFEST}
    python: ${KERNEL_EVAL_PYTHON}
    device: 0
    seeds: [42]
    timeoutSeconds: 900
    profiling:
      enabled: true
      collection: Default
      warmup: 25
      attemptTimeoutSeconds: 300
      maxAttempts: 2
      cacheEnabled: false
run:
  timeoutSeconds: 960
```

Merge this fragment into an existing experiment including the placeholder service above. `benchmark.config.device` selects one physical card: both visibility variables are set to that card and the worker uses logical device 0. Inherited multi-card visibility does not expand the allocation.

The following fields belong to `benchmark.config.profiling`:

| Field | Default and behavior |
| --- | --- |
| `enabled` | `false`; evaluation still runs correctness and standard timing when disabled |
| `warmup` | `25` replay calls before capture; separate from `benchmark.config.warmup` used for timing |
| `attemptTimeoutSeconds` | `300` seconds per profiler process |
| `maxAttempts` | `2`, including the first attempt; structural omissions such as missing required CSVs are not retried |
| `retryDelayMs` | Optional nonnegative integer before each retry; `0` skips waiting. Omitted: exponential 2s, 4s, …, split across valid Node timer intervals |
| `roundNum` | `1`; labels artifacts and metadata, without repeating capture |
| `msprofBin` | Optional existing executable path; otherwise try `/usr/local/Ascend/ascend-toolkit/latest/bin/msprof`, then `msprof` on PATH |
| `cacheEnabled` | `true` for evaluation; independent `operation: profile` requires an explicit `false` |
| `cacheDir` | Optional cache directory; use an absolute path because this field is not rebased to the experiment YAML |
| `cacheMaxEntries` | Optional positive integer; evict the oldest cache entries after writes only when a capacity is configured |
| `deviceName` | Accepted for existing configurations; it does not currently supply hardware denominators or enable UB/core-derived metrics |

`benchmark.config.timeoutSeconds` caps the entire verification phase, including correctness, timing and profiling. It defaults to `maxAttempts * attemptTimeoutSeconds + 300` with profiling enabled, otherwise `300`. Set `run.timeoutSeconds` above that cap; the built-in profile's 360-second run default is insufficient when profiling uses its default 900-second verification cap. Allow time for retry backoff and parsing; an outer timeout can interrupt collection before a complete receipt exists.

`benchmark.config.seeds` accepts any nonempty list of unique unsigned 32-bit integers. Timing `warmup` and `repeat`, profiling warmup, attempt count and timeouts are caller-controlled positive integers. There is no separate seed-count or iteration-count ceiling. Independent profiling still requires exactly one seed for its capture receipt.

These process controls belong directly to `benchmark.config`:

| Field | Default and behavior |
| --- | --- |
| `outputLimitBytes` | Omitted: retain complete worker/profiler output. An explicit positive integer caps each stdout/stderr stream and fails collection if exceeded |
| `cleanupGraceMs` | `100`; graceful-stop period used by the kernel result reader and profiler cleanup |
| `cleanupTimeoutMs` | `3000`; wait to confirm profiler exit after stopping it; an unconfirmed exit remains an infrastructure failure |

Complete protocol output is retained even when the child exits before output consumption begins. Native worker errors and strict-check messages are stored without character clipping. Profiler console logs are retained for unsuccessful process exits as well as successful captures. Cache entries are retained without automatic eviction when `cacheMaxEntries` is omitted.

Timeouts and cleanup waits must fit the Node timer range of 2147483647 milliseconds; larger values are rejected before execution. Retry delays can exceed one timer interval because they are split without shortening the requested wait.

Replay uses the unchanged `problem.get_inputs()` and the first configured seed. Warmup completes before one call inside an MSTX range (`rsi_operator_profile`). SDK sessions own all profiler children. Cancellation propagates to those child processes; unconfirmed cleanup is an infrastructure failure.

Two explicit collection protocols are supported:

- `PipeTimeline,Default` (default) requires PipeUtilization, L2Cache, ResourceConflictRatio CSVs and usable trace evidence.
- `Default` requires the three CSVs and marks trace unavailable with reason `not-requested-by-default-protocol`. Pipeline overlap/bubble/Double Buffer analysis is null. It never claims the full protocol passed.

Missing required evidence produces unavailable diagnostics, distinct from incorrect candidate code. Raw CSV, trace when available, replay metadata and process logs are retained. Source identity, case, seed, warmup, collection and device context identify reusable evidence. Independent profile runs disable disk cache so the caller owns reuse; evaluation-mode caching is optional.

`KA_MSPROF_CACHE_DISABLED=1` disables disk caching even with an explicit `cacheDir`. Otherwise, the directory is `cacheDir`, then `KA_MSPROF_CACHE_DIR`, then `~/.kernel_agent/msprof_cache`. A hit requires matching candidate bytes, reference hash, case, seed, warmup, collection and device scope; cached replay metadata is validated and available cached profile evidence is copied into the current attempt. `profiling.metadata.cacheRequested`, `cacheEnabled` and `cacheHit` distinguish requested caching, actual availability and reuse.

Before publishing a completed independent diagnostic, the benchmark checks the effective case/seed/warmup/collection, trace availability, frozen candidate/reference hashes and replay logical device 0. A mismatch fails verification. A failed collection produces `verdict.details.status: unavailable`, `verdict.passed: null` and no candidate score. This differs from an incorrect candidate in a full evaluation.

Parsing retains ngo-agent-style block tables, final-row selection and three-decimal numeric rounding. Empty, nonnumeric and nonfinite CSV cells are omitted from per-block metrics; measured zero is preserved. Missing roofline inputs remain null. UB ratio and core utilization derived from hardcoded hardware assumptions are unavailable; hardware facts must come from verified context. Diagnostic roofline classifications are hints, not proof of speedup. Profiler durations do not replace referenceMs/candidateMs.

| Metric fields | Units and interpretation |
| --- | --- |
| `aic_time(us)`, `aiv_time(us)` | Microseconds from the profiling sample |
| `aic_*_ratio`, `aiv_*_ratio` | Pipeline utilization, wait, conflict or arithmetic ratios according to the named field; not percentages, GB/s or FLOPS |
| `aic_read_hit_rate(%)` and related L2 hit fields | Percent |
| `aiv_gm_to_ub_bw(GB/s)`, `aiv_main_mem_read_bw(GB/s)` | Measured GB/s |
| `GM_to_UB_bw_usage_rate(%)` | Bandwidth utilization in percent |
| `read_main_memory_datas(KB)`, `write_main_memory_datas(KB)` | Original KB, without conversion to KiB |
| `aiv_mte2_instructions` | Instruction count |
| `l2_cache_analysis` | Structured conclusions and supporting evidence |

`Memory.csv` and `ArithmeticUtilization.csv` are optional; their fields may be absent, including for cube-only operators. Required tables and at least one finite core-pipeline ratio in the range 0–1 must be present for fresh capture to succeed. Inspect `profiling.metadata.metricUnits` and `missingMetrics` when present, along with the raw CSVs, before using individual fields.

## Metrics and Results

Evaluation type is quality; independent profiling uses performance. `passed/score` means output equivalence only:1 on pass,0 for candidate error/incorrectness. Correct slower candidates still pass with speedup<1.

Timing now ships as `timing.bench_kernel_ms` without external source access. Optional `benchmark.config.kernelRoot` retains external timing compatibility, locking external modules and their behavior. Both reference/candidate use `triton_only=False` for all device kernels per call, excluding CPU launch overhead. Built-in timing retains real reductions such as ReduceSum and validates finite nonnegative CSV rows. Missing columns/data, incomplete records, or nonpositive totals invalidate timing. Warmup is excluded; units ms. Timing uses the final seed's input; separate shapes into tasks.

`metrics.json` `metrics["kernel"]` contains:

| Field | Meaning |
| --- | --- |
| `selected / valid / invalid / pending` | Selected, judged, invalid, unfinished task counts |
| `passed / measured / faster` | Correct, fully timed, correct-and-faster counts |
| `passRateValid` | Correct / valid judgments |
| `passCoverage / fasterCoverage` | Correct or faster / all selected |
| `geometricMeanSpeedup` | Geometric mean for correct, fully timed tasks only |
| `profilingRequested` | Saved tasks explicitly requesting profiling |
| `profiled / profilingErrors / profilingUncollected` | Completed, failed, requested-but-uncollected |
| `profilingCoverage` | Profiled / all selected |
| `rows` | Reference kind, status, durations, speedup, profile summary/evidence per task |

Missing NPUs, reference failures, missing/invalid timing, worker protocol errors, and verification timeouts invalidate evaluation rather than candidate zero. No-data metrics are null, never NaN/Infinity. Consider coverage alongside average successful speedup.

`faster` means strictly>1, not statistically significant improvement; repeat near1 differences. Keep drivers/Python versions consistent; source locks do not manage environments.

Evaluation attempts save `verifier/kernel-result.json`; independent profiling saves the validated diagnostic receipt as `verifier/kernel-profile-result.json`. Profiling saves `verifier/kernel-profile.json`, `kernel-profile.raw.json` and a `kernel-profile_profiling_root/` artifact tree, including replay metadata, raw CSVs, trace when requested, `profiling/original-result.json` and logs. Use the saved `profiling.artifacts` list for verifier-relative paths. For failed capture, inspect `profiling.error`, `profiling/logs/profiler.log` and `profiling/logs/console.log`; a replay error may explain missing downstream CSVs. For timeout without full results, inspect attempt `errors`; the framework stops worker process groups. Saved results rebuild offline.

`report.md` labels new original-kernel results and displays original metrics/L2/status/evidence. Historical LAST/unmarked results retain their definitions. `metrics.json` stores coverage/task summaries without recollection. RSI reads `verdict.details.profiling` from `tasks/<task-key>/attempts/<attempt-id>/result.json`:

```text
profiling.schemaVersion = 1
profiling.status / error                    # Collection status and error
profiling.kernels[].name                    # Kernel identity
profiling.kernels[].metrics[blockId]         # Available fields from the selected block
profiling.kernels[].metadata.outputPolicy   # kernel-original-f542-v1; historical results have older values or omit this field
profiling.kernels[].metadata.upstreamCommit # Pinned source implementation commit
profiling.kernels[].metadata.originalMetadata # Captured paths, round and timestamp
profiling.metadata.diagnosticProtocol       # Effective case, seed, warmup, collection, scope and selection policy
profiling.metadata.sources                  # Frozen candidate/reference hashes and optional contract hash
profiling.metadata.replay                   # Observed replay settings, device and MSTX capture
profiling.metadata.trace                    # Trace availability and reason
profiling.metadata.cacheRequested / cacheEnabled / cacheHit # Cache request, availability and reuse
profiling.metadata.hardwareDerived          # Unavailable hardware-derived fields and reason
profiling.analysis.trace / roofline         # Each analysis may be null when unavailable
profiling.artifacts                        # Raw evidence paths relative to verifier/
```

Older saved results may contain `originalResultJson`, `originalReturnedNone` or `serializationConversions`; current capture does not require or emit those metadata fields. Locate current `original-result.json` through `profiling.artifacts`. Historical records are read without recollecting or redefining their metrics.

Check executionStatus/scoreStatus/verdict.passed for correctness/timing and `profiling.status` independently for collection. Profile failure does not imply incorrectness. Numeric consumers must verify actual required finite fields, not only exit codes. Uses existing CLI/Node SDK without HTTP services; Python may subprocess the CLI and read JSON. Offline reports call neither models nor NPUs.

```bash
# Use the directory printed by run; no model credentials or operator rerun needed.
ember-evaluator report /absolute/path/to/results/run-id
# Resume with identical configuration; referenced environment variables are still required.
ember-evaluator run playbook/kernel/existing.yaml --resume
```

dry-run proves only configuration/source parsing, not NPU readiness. Missing torch/torch_npu/NPU during `run` returns nonzero with invalid records, not evidence of candidate correctness.

## Independent Measurement Atoms

Besides full runs, three independent atoms support external orchestration such as RSI or manual use:

```bash
# Precision gate: two runs per seed against problem.Model (defaults atol=1e-5 / rtol=1e-3)
ember-evaluator kernel precision --problem <problem.py> --kernel <kernel.py> \
  --out <precision.json> [--seeds 0 1] [--python /usr/bin/python3]
# Timing only: same timing module as the benchmark (see Metrics and Results); no precision check
ember-evaluator kernel bench --problem <problem.py> --kernel <kernel.py> \
  --out <bench.json> [--warmup 25] [--repeat 100] [--python /usr/bin/python3]
# msprof attaches to replay for hardware metrics, with cache/retries and roofline classification
ember-evaluator kernel profile --problem <problem.py> --kernel <kernel.py> \
  --out <profile.json> [--round 0] [--seed 42] [--warmup 25] [--python /usr/bin/python3]
```

All three commands accept `--timeout-ms` and `--output-limit-bytes`. Bench/precision default to a 900000 ms timeout; `--timeout-ms 0` disables that overall timeout. Profile has no additional overall timeout unless supplied; `--max-attempts` (default 2) and `--attempt-timeout-seconds` (default 300) control its capture attempts independently. Profile also accepts `--retry-delay-ms`, `--cache-max-entries`, `--cleanup-grace-ms` and `--cleanup-timeout-ms`.

Each outputs one JSON object:

| Atom | Output fields |
| --- | --- |
| `precision` | `passed` (bool), `error`, `seeds`, `tolerance` |
| `bench` | `time_ms` (ms), `error` |
| `profile` | `round`, `measured_by`, `metrics` (block pipelines/L2/bandwidth), `trace_analysis` (longest core/overlap/bubbles/Double Buffer, absent without trace), `roofline` (bottleneck/efficiency_rate/pipelines/warnings), `artifacts`, `error` |

Roofline: maximum pipeline utilization<0.8 yields `no` (underutilization first); otherwise pipelines>=0.4 classify bottlenecks in scalar→vec→mte2→mte3 order.

Exit contract: business failures such as compilation/precision set `error`, still write `--out`, and exit 0. Missing interpreters/timeouts/cancellation exit nonzero. `--python` defaults `python`; use torch_npu-capable interpreters. `KERNEL_ATOM_DIR` overrides executor directory, otherwise located from installation.

All atoms accept `--device <n>` for the logical NPU ID, default 0, equivalent to KERNEL_NPU_DEVICE. Full runs use benchmark.config.device. Targets must be allowed by ASCEND_RT_VISIBLE_DEVICES. Profile caches separate visible sets/target IDs; evidence is not exchanged across cards.

## RSI Integration

RSI's `application.kernel` seals candidate source, `proposer.operator` generates changes, and `evaluator.operatorbench` invokes `Evaluator.run()` using the kernel benchmark and kernel-replay solver. RSI installs the pinned `ember-evaluator` SDK; it does not discover a sibling checkout or run a separate CLI bridge. Evaluation and independent profiling are separate SDK operations. Measurement evidence links to the saved native result and verifier artifacts; evidence availability and calibration label confidence separately from candidate generation.

The SDK owns runtime assets, dependencies and prepare/build. Use the SDK package exports for contract and timing validation. An installed-consumer test can prove packaging and software integration without proving NPU correctness or performance; those require a real device run.
