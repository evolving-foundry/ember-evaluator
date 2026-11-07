# Benchmark Development Guide

> English | [中文](./benchmarks.md)

For developers writing/modifying benchmark plugins: implementation locations, interfaces, registration, and validation. Deliverables are plugin code, profiles/patches, and regression tests.

Obtain [task specifications](benchmark-evaluation-requirements.en.md#2-complete-task-specifications-first) first, then perform [staged acceptance](benchmark-evaluation-requirements.en.md#11-staged-acceptance) after implementation. That guide owns official images/platforms/resources/timeouts/runtime acceptance; this guide describes code implementing them.

## Choose an Implementation Location

See [Source architecture and execution flow](architecture.en.md) for directory responsibilities, calls, and dependency limits. This guide owns the implementation locations for task conversion, scoring, Profiles, and protocols.

Benchmarks are grouped by evaluation target: agent-harness, inference-engine and operator. All three use the existing engine and component contracts. Source clients organize external downloads. Determine whether new behavior is record reading, task conversion, existing-protocol configuration, or a new protocol:

| Approach | Scope | Code changes |
| --- | --- | --- |
| `BenchmarkDefinition + DatasetRecordSource` | Record-readable sources with mostly text inputs/results | Definition handles public/private conversion/scoring; Source pins/reads data |
| Harbor Profile | Tasks expressible with Harbor/existing environments/verifiers | Add source/component defaults without copying execution |
| Full `Benchmark` | Custom task environments/state delivery/protocol | Implement contracts below, reusing environments/verification/scheduling/storage |

Avoid benchmark-name branches in Engine/Solver. New sources should not duplicate task conversion/scoring.

| Directory | Responsibility |
| --- | --- |
| `src/plugins/benchmarks/agent-harness/definitions/` | Evaluator-defined task conversion/private answers/scoring, e.g. GSM8K |
| `src/plugins/benchmarks/agent-harness/protocols/harbor/` | Harbor environments/artifacts/verifiers |
| `src/plugins/benchmarks/index.ts` | Composes the three category registration functions; not an evidence import entry |
| `src/plugins/benchmarks/inference-engine/agentx/` | Workloads, saved results, telemetry and statistical evidence |
| `src/plugins/benchmarks/operator/kernel/` | Precision, timing, profiling, scoring and Python assets |
| `src/plugins/benchmarks/<category>/profiles/` | Default combinations/sources/versions/scenarios |
| `src/infrastructure/datasets/sources/` | HF/GitHub downloads/caches/locks |
| `src/infrastructure/datasets/input-readers/` | JSONL/Parquet/CSV records; Harbor TOML and Compose semantics live in Harbor's readers directory |
| `src/infrastructure/datasets/cache.ts` | Shared content-addressed cache |

![Adapters own sources/cache; benchmarks create public tasks/private verification; solvers never read hidden answers](../users/imgs/04-framework-benchmark-boundary.png)

The fork marks delivery boundaries: public input reaches Solver; private materials remain for verification. `runTask` calls Benchmark.verify with solve results/declared state. Solvers do not invoke verifiers. Adapters own downloads, benchmarks own scoring.

## Where to Add New Behavior

| Requirement | Implementation and registration |
| --- | --- |
| Questions, choices, code tasks or custom scoring | agent-harness/definitions, source configuration, Profile and agent-harness/index.ts |
| Harbor task set | agent-harness/profiles; change protocols/harbor only for protocol differences |
| Independent Agent evaluation | A standalone Benchmark under agent-harness, with Solver/Verifier as needed; no requirement to extend DefinedBenchmark |
| Inference engine workload | inference-engine Benchmark, workload Solver, evidence, metrics and Profile |
| Operator evaluation | operator Benchmark, execution backend, precision/timing evidence, metrics and Profile |
| Agent framework | Runtime installation/bridge code and its Solver |
| Lifecycle phase or cross-task state | Design core/contracts first, then change execution, preparation, scheduling and recovery |

Register Benchmarks and Profiles in each category's index.ts. Profiles retain the existing IDs, inheritance and cross-category duplicate checks. The root plugin entry only composes registration modules. Use shared only for existing reuse. Specialized Metrics/Reporters remain in their role directories and import explicit evidence modules.

AgentX evidence processes saved output without loading installers, samplers or network probes. The Solver connects runtime output to evidence parsing. Runtime modules do not import Benchmarks; shared version constants live in a runtime leaf module without I/O.

Put unit tests in tests/unit, component/registration/config/resume tests in tests/integration and reusable inputs in tests/fixtures. Cover success, failure, cancellation, cleanup and offline reporting. Record real Docker/Ray/NPU/model acceptance separately from controlled tests.

## Limits for Future Memory Evaluation

A possible sequence is environment ready → import history → ask → verify → clean up. Benchmark owns history interpretation, ordering and scoring; Solver receives public questions; core manages timeouts, cancellation, records and cleanup. Specify isolation and recovery separately for within-task history and cross-task shared state.

Benchmark.prepare() runs before environment creation and cannot initialize a running memory service. Existing multi-step tasks also have the bash setup.sh initialization convention. New lifecycle stages require an explicit contract design before execution/scheduling changes. No placeholder hooks, workflow DSL or sample memory service are introduced for this future use case.

## Full Benchmark Interface

[Benchmark](../../src/core/contracts/benchmark.ts) requires four methods:

| Method | Requirements |
| --- | --- |
| `resolveSource(previous, signal)` | Return locked sources; validate `previous` on resume, never treating changed content as original |
| `enumerate(source, signal)` | Unique/stable `TaskRef` IDs and deterministic order |
| `prepare(ref, source, signal)` | `PreparedTask` with `input.id === ref.id`; no actual solving |
| `verify(task, result, session, signal)` | Legal `VerifyResult` from private materials/delivered state |

[PreparedTask](../../src/core/contracts/task.ts) separates public input/private verification. solveEnv/verifyEnv/transfer declare environments/state. `shared` requires verifyEnv/transfer null. Separate environments/transfers must pair; never assume `shared` node filesystems.

Put platform/resources in [EnvironmentSpec](../../src/core/contracts/environment.ts). phaseTimeoutSeconds.solve/verify bounds execution; preparationTimeoutSeconds.solve/verify supplies bases. planRun returns tasks/preparation.defaultTimeoutSeconds. Scheduler provides effective node `concurrency`; common preparation multiplies by `min(C, 10)`, with no default round cap. External schedulers pass concurrency/defaultTimeoutSeconds/roundSignal/optional `environmentTimeoutSeconds` through TaskPreparationContext. Shared description work uses `roundSignal`; task phases use their own signals. See [preparation budgets](../users/config.md#environment-preparation-timeouts).

Optional `validateRun(config)` performs resource-free cross-component checks, called by bootstrap/dry-run/engine. discloseAnswer exposes controlled evidence without changing public inputs. `validateSourceOnCompletedResume` requests source checks for completed resume.

## Evaluator-Defined Conversion and Scoring

`BenchmarkDefinition` in `definitions/benchmark-definition.ts` defines partitions, optional preprocessing/auxiliary data, prepare conversion, and verify scoring. input/verification separate public/private data; solvers receive no answers.

`DefinedBenchmark` in `definitions/defined-benchmark.ts` receives `DatasetRecordSource` with resolve(previous,signal)/rows(lock,selection,signal). Any compatible adapter works; benchmarks do not instantiate HF downloaders themselves.

Definition.prepare returns only input/verification; `DefinedBenchmark` supplies default environments. Definitions cannot declare full resources/phase budgets. Use Harbor/full `Benchmark` for task containers/transfers/separate verification. Private helper processes may use `verificationRuntime` below.

GSM8K example:

1. `definitions/gsm8k.ts` defines question/answer conversion, prompts, extraction/comparison.
2. `definitions/index.ts` associates it with `openai/gsm8k` file selection, owning download policy without I/O.
3. `plugins/benchmarks/agent-harness/index.ts` registers `gsm8k` through Cordis; factory injects `HuggingFaceFilesSource` into DefinedBenchmark.
4. `infrastructure/datasets/sources/huggingface/` owns networking/HF_TOKEN/mirrors/cache/locks.

Other-source adapters reuse definitions without scoring/Engine changes. Third-party plugins import DefinedBenchmark/BenchmarkDefinition/DatasetRecordSource from the package root, register through Cordis, and load explicit patches. Registration/validation starts no downloads/evaluations. Public contracts/reusable capabilities are root exports.

Selected components/profiles validate benchmark.name/cacheDir/hfToken/dockerExecutable. `hfToken` interpolates YAML/SDK env; hfTokenEnv is rejected. Credentials declare `secretFields: ["hfToken"]` for Ray stripping; nodes read own HF_TOKEN. HF fields belong to built-in source combinations, not all definitions.

For private verification processes, `verificationRuntime(context)` returns an implementation managed by DefinedBenchmark/framework. HumanEval Python resolves to local image IDs during preparation, then scores only inside created verification containers. See [verification runtimes](plugins.en.md#verification-runtimes).

## Harbor Benchmarks

`protocols/harbor/source.ts` owns source policy; `task.ts` parsing; `verify.ts` reward mapping; `compatibility.ts` constraints. `harbor-benchmark.ts` composes contracts; shell/Python execution stays in Verifier plugins.

For supported Harbor packages, add profiles extending `harbor` and reuse execution. Special behavior belongs in its adapter/Verifier rather than copied workflows. See [image requirements](benchmark-evaluation-requirements.en.md#4-prefer-official-images-to-dockerfiles) and [Harbor fields](../users/benchmarks/harbor.md).

## Source Adapters

sources/huggingface handles Hub/endpoints; github handles trees/blobs/materialization; local snapshots directories; http safely downloads/extracts digest-pinned archives. HTTP reuses `datasets/cache.ts`; directory materialization owns platforms/atomic publication, not tasks/scoring. local/http currently provide directories, not automatic record conversion for arbitrary inputs.

## Task Preparation Failures

With `planBenchmarkRun()`, prepare can throw `new EvaluatorError("TASK_DATA_INVALID", message)` or BENCHMARK_UNSUPPORTED. Planning records `preparationFailures` and checks remaining tasks; `run.onError` determines execution. Import `EvaluatorError` from package roots without Harbor-specific codes.

Only these explicitly declared top-level task errors qualify. Source/config/unknown exceptions stop planning. Plain `Error`, code text, unknown `UNSUPPORTED_*` prefixes, or codes only in cause do not qualify. Explicit network task-source failures retain bounded recovery; run-level errors never downgrade. Harbor uses the same codes without legacy conversion.

Download changes require lock/offline-resume tests; Definition changes require public/private/scoring tests; defaults require parsing tests. Internal renames preserve task/source IDs, but source/package paths affect digests; retain version consistency checks.

## Lifecycle and Resource Ownership

| Method/phase | Responsibilities and allowed I/O |
| --- | --- |
| import/apply/validate/Profile | Declarations/checks only, no downloads/containers/models |
| resolveSource | Lock source/version/digests with cancellable source I/O |
| enumerate | Stable unique IDs from locked sources, no solving |
| prepare/planRun | Public/private materials, locked input materialization; no solve processes/models; return plans/budgets |
| Solver.prepare/solve | Public inputs/environment only; own subprocess/PreparedSolver lifetime, no verification |
| Benchmark.verify/Verifier | Interpret answers/evidence; private verification protocols, not scheduling/storage |
| Metrics/Reporter | Offline ResultSnapshot calculations; configDirectory/resolvePath only, no model auth |

One command owns one Registry shared explicitly across config/assembly; independent loadConfig/bootstrap calls own lifetimes. Validate all selected components before factories. Creators release resources through Cordis effects/Sessions/PreparedSolver on success/failure/cancellation.

All I/O/process/container work must propagate/respond to AbortSignal. Promise timeouts alone do not stop underlying work. Stop writes/release resources before handing directories to later tasks. Avoid long synchronous computation blocking cancellation.

## Scores and Diagnostic Evidence

Absent `VerifyResult.score` means unmeasured, not zero; `passed: null` means no binary judgment. Continuous-only scores need no invented thresholds. Confirm official rewards/thresholds/denominators through [scoring requirements](benchmark-evaluation-requirements.en.md#9-verify-official-scoring-and-result-definitions) before implementing.

Ground-truth-free performance protocols set `Benchmark.evaluationKind = "performance"`, pass public workloads through `payload`, and return offline summaries in observations. Verification checks identities/artifacts/completeness and returns `passed: null` without score; core marks not-applicable. Preparation mode is independent; core does not parse traces. See [AgentX](../users/benchmarks/agentx.md).

To retain partial diagnostics, import `VerificationError` and throw new `VerificationError`(message,jsonEvidence,{cause}). Core saves redacted evidence in scoreless passed:null verdict.details while attempts remain invalid/cancelled. Offline metrics exclude them; resume reruns. Ordinary exceptions keep existing handling without benchmark-specific classes.

Framework owns `AttemptRecord.trajectory`, with or without verdict. `VerifyResult` accepts no `trajectory`; verifiers cannot redeclare evidence paths through legacy fields.

## Publish Default Profiles

Profiles are Cordis-registered configuration metadata; existing execution components still implement behavior:

```js
export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.registerProfile({
    id: "my-benchmark",
    role: "benchmark",
    extends: "harbor",
    plugin: { name: "harbor", config: { /* Pinned source, tasks, scoring */ } },
    defaults: { run: { timeoutSeconds: 3600 } },
  });
}
```

ConfigProfile/UserConfig/ResolvedProfiles/resolveConfig are root exports. Profiles support versions/scenarios/defaultVersion/defaultScenario. `$default` marks verifier default service binding. Solver profiles use role:solver/plugin to select implementations. Explicit patches load modules; registration/validation allocates no evaluation resources.

Built-ins live in each category’s profiles directory. Inheriting harbor YAML publishes compatible datasets without Loader/Engine edits. External plugins may read packaged YAML through readProfileDirectory/registerProfile. Duplicate IDs/cycles/missing parents fail. Ship files in packages/node digests; built-in YAML already ships.

## Three Runnable Integration Examples

Complete two-task examples live in [fixtures](../../tests/fixtures/benchmark-examples). Plugins import roots only and share [patch.yaml](../../tests/fixtures/benchmark-examples/patch.yaml), without core/registry edits.

These validate discovery/config/execution during development. Real dataset images/platforms/resources/scoring require [staged acceptance](benchmark-evaluation-requirements.en.md#11-staged-acceptance), not fixture substitutes.

| Approach | Implementation/configuration | Scenario |
| --- | --- | --- |
| Definition+Source | [definition.mjs](../../tests/fixtures/benchmark-examples/definition.mjs), [source.mjs](../../tests/fixtures/benchmark-examples/source.mjs), [definition.yaml](../../tests/fixtures/benchmark-examples/definition.yaml) | Records→public questions/private scoring |
| Harbor Profile | [harbor-profile.mjs](../../tests/fixtures/benchmark-examples/harbor-profile.mjs), [tasks](../../tests/fixtures/benchmark-examples/harbor), [harbor.yaml](../../tests/fixtures/benchmark-examples/harbor.yaml) | Existing instruction/TOML/test files reuse Harbor |
| Full protocol | [protocol.mjs](../../tests/fixtures/benchmark-examples/protocol.mjs), [protocol.yaml](../../tests/fixtures/benchmark-examples/protocol.yaml) | Custom sources/TaskRefs/environments/verification through Benchmark |

Follow [installation](../users/installation.md), build, set MODEL_NAME/MODEL_ENDPOINT/MODEL_API_KEY, then run from root in WSL/Bash:

```bash
ember-evaluator benchmark list --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator benchmark info example-definition --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator doctor tests/fixtures/benchmark-examples/definition.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator run tests/fixtures/benchmark-examples/definition.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
```

Replace `definition.yaml` with `protocol.yaml` or harbor.yaml. Harbor needs Docker/pinned Node; models need tools/file writes. `doctor` runs download/build probes without calling models; execution may download runtimes. Results live under .scratch/benchmark-examples/. Pass output to ember-evaluator report `<run-dir>` for offline rebuild without authentication. Saved report-plugin provenance loads Metrics/Reporter; no repeated patch argument is needed.

For init-generated configurations, copy example data beside output so profile-relative paths remain valid:

```bash
mkdir -p .scratch/benchmark-init
cp tests/fixtures/benchmark-examples/questions.json .scratch/benchmark-init/
ember-evaluator init --benchmark example-protocol --output .scratch/benchmark-init/experiment.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator doctor .scratch/benchmark-init/experiment.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator run .scratch/benchmark-init/experiment.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
```

`init` never overwrites. Harbor copies `harbor/` beside config. Change `benchmark.config.path` for records or source for Harbor. Paths are always YAML-relative, not patch-relative.

### Example Boundaries

Shared `source.mjs` checks cancellation/records/content on every read and rejects source changes; it serves this two-task example only. Full protocol validates TaskRef and keeps answers in verification. Harbor injects hidden tests only during `verification`, never public images/inputs. To pin bytes, record SourceLock.files hashes like real adapters; example revision pins parsed content.

No background resources means no extra dispose. Adding processes/temp directories requires creator-owned Cordis effects/Session.dispose/PreparedSolver.dispose, including failure/abort. Never unlock and hand off still-writing directories. Optional `planRun` supports batch preparation; ordinary protocols need only four required methods without new framework mechanisms.

For complex performance protocols, follow AgentX: Benchmark sources/points, adapter replay, saved observations for metrics/reports, no new component category.

## Plugin Regression Tests

After `pnpm build`, run `pnpm test --run tests/integration/benchmark-examples.test.ts` for locks/unique IDs/serialization/boundaries/source changes/cancellation. Two record examples also cover discovery/doctor/run/offline report/resume through controlled Solver. No models/Docker are used; Harbor Docker needs separate acceptance.

Reuse [registry lifecycle](../../tests/integration/registry-lifecycle.test.ts), [engine lifecycle](../../tests/integration/engine.test.ts), [AgentX completion/cancellation/resume](../../tests/integration/agentx.test.ts), and fixture memory sources/mock processes without a new test SDK.

See [development rules](../../AGENTS.md#代码开发规范) for checks/build/tests. Distinguish controlled regression from real runs; final delivery cites integration acceptance.

[Development documentation](README.en.md) · [Requirements/acceptance](benchmark-evaluation-requirements.en.md) · [Plugin development/loading](plugins.en.md)
