# Plugin Development and Loading

> English | [中文](./plugins.md)

Covers eight component interfaces, runnable metric plugins, explicit patches, and Ray deployment. Source commands/experiments paths are relative to the Evaluator root.

[Project home](../../README.md) · [User guide](../users/README.md)

## Source and Registration Locations

Built-in components register in each role's index.ts; Metrics and Reporter use metrics/index.ts and reporters/index.ts respectively. Benchmarks have three registration entries: agent-harness, inference-engine and operator. application/plugins/open-registry.ts creates the Cordis registry and registers plugins, load-module.ts locates and imports modules and reads versions, create-components.ts creates components using an existing registry, and bootstrap.ts provides the public entry that opens and disposes its own registry. config/plugin-patch.ts only reads patches, validates entries, and computes patch digests; it does not execute plugin modules. External plugins import public contracts from ember-evaluator, not internal directories. See [Source architecture and execution flow](architecture.en.md) for calls and resource ownership, and [Benchmark development](benchmarks.en.md#where-to-add-new-behavior) for implementation locations and lifecycle limits.

Run `pnpm check:dependencies` to check imports, boundary violations, and executable module cycles. See [dependency rules](architecture.en.md#allowed-source-dependencies) for allowed relationships and coverage limits. Plugins use explicit patches; manifest discovery and plugin-declared CLI commands are not supported.

### Published Process Entries

`pnpm build` generates the public package/CLI entries and the existing `dist/adapters/ray/{node-worker,jobs-entry,jobs-retry-entry,jobs-gateway}.js`, Ray `python/requirements.txt`, `dist/adapters/harness/pi/` standalone bundle and `dist/adapters/harness/agentx/assets/ascend_metrics.py`. These deployment paths remain available; internal code uses the new directories. Generated entries and assets are included in the package digest.

After installing an actual packed package with runtime dependencies outside the checkout, run `node scripts/verify-distribution.mjs <installed-package-directory>` from the repository. The target must contain no src or scripts directory. This checks CLI, package-name SDK execution/reporting, Pi protocol, worker task/maintenance/version rejection, Jobs entry processing/gateway and AgentX Python startup. OpenSSL and Python may be selected using OPENSSL_BIN and PYTHON_BIN; unavailable tools are reported as skips. This controlled check does not replace real Docker/Ray/NPU/model acceptance.

## Component Types

Components may report live activity. Solvers use `AttemptContext.activity?.({ message, lines, activity })`; Environment `materialize` argument4, `prepare` argument5, `installRuntime` argument4 accept the same callback. `onImageReady` retains position/meaning. Plugins without callbacks still work. ActivityListener/ComponentActivity are root exports.

`materialize` argument5 optionally takes `EnvironmentPreparationContext`:`{ taskId, phase: "solve" | "verify" }`, exported at root. Batch/pipeline/Ray supply it; Docker uses task/purpose image names. Direct `prepare` gets attempt/phase identity. External environments may ignore it; wrappers should forward all args. It changes no task/access boundaries; absent context uses `shared` names. See [Docker naming/cache](../users/faq/docker.md#identify-and-inspect-task-images).

With context, Docker migrates digest-pinned external images to stable Evaluator tags, validates/saves provenance, then removes official local references. Use returned receipts rather than assuming official references persist. Declarations/results retain sources. Fixed Node/mutable tags/context-free calls skip migration; see FAQ.

Benchmark resolveSource/enumerate argument3 and prepare/planRun argument4 optionally accept ActivityListener. Adapters report real bytes/cache/file counts; planning reports indices. Exclude private paths/content. Existing plugins may omit callbacks. Report real work, not simulated heartbeat progress; callers maintain timing/end states.

Standalone plugins reuse root DatasetCache/GitBlobCache/parseGitTree/writeGitFile/checkedPath/planBenchmarkRun. `GitLfsCache` handles pointer/batch; `GitHubLfsSource` fetches repository/revision/path archives with pointer Git-SHA verification. `DockerImageArchiveLoader` manages shared requests/cancellation/loading/renaming. Plugins supply source parameters/image mappings; see [DocOps](../../plugins/docops/README.md).

For external build bases, pass `prepareBuild(spec, signal, activity?)` to DockerEnvironment. It runs after a task image cache miss and successful snapshot validation. `spec.build.context` points to a temporary snapshot; callbacks must only read it and must not modify task files. Build follows a successful callback; failure/abort stops it and the environment cleans snapshots. This is plugin code, not YAML. Subclasses retain materialize/installRuntime/prepare/recoverAttempts. Receipt-based attempts do not repeat callbacks.

`lines` contains public commands/output only, excluding reasoning/answers/hidden tests/secrets. Redact within components; receivers also bound/redact. Report activity only on actual executor/model/tool events; capability notices use activity:false. Activity affects neither scores nor saved evidence. Schedulers send structured progress through onProgress, never serializing whole contexts.

Substeps may supply unique operationId/status started/updated/completed/failed/cancelled. Reuse IDs within a step only; never after completion. Core nests under caller operations and closes unfinished children. Shared builds publish identical component IDs to waiters; core adds each task/attempt identity.

Cordis loads modules; ctx.evaluator.register registers components. Modules may register several; experiment names select them.

Record definitions live in `src/plugins/benchmarks/agent-harness/definitions/`: task files convert/select scoring; `records.ts` validates/builds; `prompts.ts` stores prompts. `scoring/` groups matching/generative-choice/probability/model-judge/code execution; complex DROP algorithms may be separate. Reuse scoring rather than requiring a new `*-score.ts` per dataset. Scoring remains benchmark business logic, not automatically a Verifier because of filenames.


| Type | Responsibility/interface | Built-ins |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `benchmark` | Sources/enumeration/preparation/verification; [Benchmark](../../src/core/contracts/benchmark.ts) | Record definitions and Harbor |
| `verifier` | Private execution/raw reward evidence; [Verifier](../../src/core/contracts/verifier.ts) | `harbor-shell`,`harbor-python` |
| `environment` | Processes/transfers/lifetimes; [Environment](../../src/core/contracts/environment.ts) | `local`,`docker` |
| `solver` | Model/agent execution/results; [Solver](../../src/core/contracts/solver.ts) | `simpleagent`,`agentbundle`,`agentx-replay`,`choice-logprobs` |
| `metrics` | Snapshot `metrics`; [Metrics](../../src/core/contracts/metrics.ts) | `success-rate`,`duration`,`usage`,`harbor-score`,`quality-score`,`agentx-performance` |
| `reporter` | Report rendering; [Reporter](../../src/core/contracts/reporter.ts) | `markdown` |
| `store` | Runs/attempts/manifests/snapshots; [RunStore](../../src/core/contracts/run-store.ts) | `local` |
| `scheduler` | Preparation/readiness/execution; [TaskScheduler](../../src/core/contracts/scheduler.ts) | `local`,`ray` |

Reporter may implement `taskReports(snapshot, metrics)` returning {id,taskId,title}. Common reporting filters task results/history/preparation, recomputes metrics, and passes optional `ReportContext` to render. `evidenceRoot` points relatively to run roots. With subreports, root `render` produces an index. Stores must implement `saveReportBundle` to save the index and each task's `points/<id>/report.md` and `metrics.json` together, checking snapshots, versions, and safe paths. Single reports pass an empty document array. The old `RunStore.saveReport` method is removed. `render` handles all reports; types are root exports.




`runtime.phaseTimeouts` carries optional YAML solve/verify overrides without defaults. Validate declarations first, then compute `PreparedTask.phaseTimeoutSeconds`; internal verifier timers must use identical final values. Omitted `VerificationTask.timeoutSeconds` creates no phase timer and follows caller signal; whole-task caps remain. Harbor/Ray preparation/execution follow this rule.

Optional `Environment.cleanupImages(request, signal)` returns daemon results; remote Scheduler `cleanupImages(request, environment, pluginVersions, signal)` invokes node capabilities. `ImageCleanupRequest`, `ImageCleanupNode`, and `ImageCleanupSummary` are root exports. `execute: false` previews without deletion/association changes. `acquireImageLease(signal)` returns an async release function; preparation/runs hold leases against cleanup. Unsupported components report unsupported; core never invokes Solver or guesses by names.

Docker records associations by runtime.imageConfigFingerprint/task/phase. Fingerprints exclude auth/output/scheduling/node-local declared fields, retaining selection. Third-party image acquisition must register ownership; preexisting sources cannot become deletable by assumption. Persist Ray EVALUATOR_CACHE_DIR.

With Benchmark.planRun, Scheduler implements prepareTasks(jobs,plan,context,signal). Local chooses batch/bounded pipeline; invoke `context.prepareTask(task, signal, { roundId, timing })` rather than duplicate runtimes/requirements/verifier setup. Return `{ tasks }` or `{ pipeline }`; pipelines need cancellable sources/completion/cancel(), waiting for active preparation on early close. All schedulers implement `executeReady(jobs, executor, signal)` for slots/dynamic retries over cancellable async streams, including batch tasks.

PreparationContext/ScheduledPreparation/createPreparationRound/runPreparationRound are root exports. Creation validates budgets/records; execution wraps batch work with absolute budgets/persistence. Omitted `context.settings` lets schedulers default: Local pipeline/equal concurrency, Ray batch. Explicit preparation is completed during config parsing; external defaults remain batch. Old array execute/prepareRun contracts are removed. No-plan benchmarks retain attempt preparation. Ray workers call common preparation; coordinators assign/check receipts without local environment callbacks.

Remote `warmup` requires setupPreparation(context,signal). `SchedulerPreparationContext` supplies sources/digests/plugin-package versions/Solver metadata/progress, without Store. Initialize connections/preparation channels only, not Runs/Attempts/result uploads. Formal runs use setup(SchedulerContext,signal). Share connection/placement code. prepareTasks may return `placements: { taskId, nodeId }[]`, including assigned failures. Execute on prepared nodes. Plugin lifecycle releases resources; cancellation waits for node work.

Store/Scheduler AttemptRecords require evaluationKind/executionStatus/scoreStatus/cleanupStatus, rejecting old status/timeoutKind. Metrics read current fields; display helpers attemptStatus()/attemptTimeoutKind() are root exports and must not be persisted. Only local Store reads convert history; new/remote records use current structures. See [results/errors](../users/reference/errors.md).

## Write a Plugin

When Solver `runtimeInstallation()` returns `RuntimeInstallation`, it may set `cacheName`, e.g. agentx-1.0.7-py3.12. Local paths are `<root>/<cacheName>/<12-char-hash>`; the default name is runtime. Names accept 1–48 lowercase ASCII letters/digits/dots/hyphens, with alphanumeric ends, excluding Windows reserved devices. Names affect local paths only; the digest still covers id/platform/files/commands, leaving Docker identity unchanged. Install directly in final directories so commands may persist absolute {root}. See [runtime caches](../users/installation.md#local-runtime-cache-and-windows-path-length).

See [benchmark development](benchmarks.en.md) for interfaces/responsibilities/lifecycles/examples and [requirements/acceptance](benchmark-evaluation-requirements.en.md) for official images/platforms/resources/timeouts/real runs.

To count completed tasks, create `custom-plugins/completed-count.mjs` at the repository root:

```js
export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.evaluator.register(
    "metrics",
    "completed-count",
    (config) => {
      if (
        config === null || typeof config !== "object" ||
        Array.isArray(config) || Object.keys(config).length > 0
      ) {
        throw new TypeError("completed-count accepts no configuration options");
      }
      return {};
    },
    () => ({
      name: "completed-count",
      async compute(snapshot) {
        return {
          completed: snapshot.records.filter(
            (record) => record.executionStatus === "completed",
          ).length,
        };
      },
    }),
  );
}
```

`register(role, name, validate, factory)` takes component role/name/validator/factory. Factories may receive config/runtime with model settings/auth/resolvePath; use authentication only for model calls, never logs/results.

Execution components receive the experiment's `npu` or `gpu` selection through `runtime.hardware`, supplied by bootstrap and Ray workers. Historical SDK callers that omit it mean NPU. Accelerator-dependent plugins select an implementation and reject unsupported hardware before allocating resources; other plugins need not probe devices. Metrics/Reporter keep their reporting context and never probe hardware for offline reports.

TypeScript plugins import HardwareKind/Metrics/Benchmark/Solver/PluginFactoryContext from `ember-evaluator` roots and implement contracts. Compile to JavaScript first; CLI does not load `.ts` entries.

## In-Repository Plugins and `ember-plugin.json`

A plugin under `plugins/<id>/` reaches the build artifacts only when it ships `plugins/<id>/ember-plugin.json`. `pnpm build` scans `plugins/`, validates each manifest, builds it (a `tsc` type check plus an optional plugin-owned bundling script), and copies the declared files into `dist/plugins/<id>/`. Directories without a manifest are neither compiled nor copied; they stay source-only.

Two build modes are available:

- **Type check plus `tsc` emit**: declare only `build.tsconfig`, for plugins that compile straight to ESM.
- **Custom bundling script**: declare `build.script` and let the plugin produce `dist/` itself, for plugins that need esbuild, resource hashes, or static asset copies (such as aisbench and docops). Both may be combined: `tsc` runs first, then the script.

Plugins loaded only through `--patch` declare `patch`, so the build installs the patch file into `dist/plugins/<id>/`. Example: [`plugins/aisbench/ember-plugin.json`](../../plugins/aisbench/ember-plugin.json):

```json
{
  "id": "aisbench",
  "description": "AISBench benchmark with an SSH solver for remote accelerator evaluation",
  "entry": "./dist/index.js",
  "bundled": true,
  "patch": "cordis.patch.yaml",
  "build": { "tsconfig": "tsconfig.json", "script": "scripts/build.mjs", "install": ["dist"] }
}
```

Load it with:

```bash
ember-evaluator run experiment.yaml --patch dist/plugins/aisbench/cordis.patch.yaml
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | Yes | Must equal the directory name and decides the `dist/plugins/<id>/` location |
| `description` | No | Plugin summary |
| `version` | No | Inherits the root `package.json` version when omitted, so it is maintained in one place |
| `entry` | No | Plugin module entry pointing at compiled JS; used by `--patch` entries that point at the plugin itself |
| `bundled` | No | `true` marks a plugin shipped with the host |
| `patch` | No | Path to the plugin's `cordis.patch.yaml`; copied into `dist/plugins/<id>/` with every `./dist/` prefix rewritten to `./` |
| `build.tsconfig` | With `build` and without `build.script` | The plugin's own tsconfig, used for a type check (`noEmit`) or to emit into `dist` |
| `build.script` | With `build` and without `build.tsconfig` | Plugin-owned Node bundling script run with the plugin directory as cwd; produces `dist/` |
| `build.install` | With `build` | Paths installed into the runtime; `dist` contents are flattened into `dist/plugins/<id>/`, other paths keep their relative position |

Build output:

```text
dist/plugins/
├── aisbench/
│   ├── ember-plugin.json  # Copied verbatim for runtime provenance
│   ├── cordis.patch.yaml  # Copied from the manifest patch, ./dist/ rewritten to ./
│   ├── index.js
│   ├── profiles/...
│   └── runtime/...
└── docops/
    ├── ember-plugin.json
    ├── cordis.patch.yaml
    └── index.js
```

`entry` is a compiled path relative to the plugin directory (for example `./dist/index.js`); the installed copy lives under `dist/plugins/<id>/`.

## Reference External Plugins with `--patch`

Create `cordis.patch.yaml` in `custom-plugins/` at the repository root:

```yaml
- insert:
    - id: custom-metrics                    # Unique module ID for provenance and version records
      name: ./completed-count.mjs            # Module path relative to this patch directory
      # name may also be an installed npm package, resolved from the patch directory.
      # Patches currently support insert only; entries accept id and name.
```

Layout:

```text
<repository root>/
├── playbook/gsm8k/gsm8k-simpleagent.yaml
└── custom-plugins/
    ├── cordis.patch.yaml
    └── completed-count.mjs
```

Add the following top-level `metrics` setting to the [GSM8K example](../../playbook/gsm8k/gsm8k-simpleagent.yaml):

```yaml
metrics:                       # Explicit lists replace defaults; include built-in metrics you want to retain
  - name: success-rate
  - name: duration
  - name: usage
  - name: completed-count      # Component name from register(), not the patch ID or module path
    # config: {}               # Component options go here; this example rejects nonempty options
```

Run from the repository root and pass the patch explicitly:

```bash
ember-evaluator run playbook/gsm8k/gsm8k-simpleagent.yaml --patch custom-plugins/cordis.patch.yaml
```

dry-run accepts identical --patch. Patch paths use current directory; local modules/npm resolve from patch directory. cacheDir/output/business paths remain YAML-relative.

See [DocOps README](../../plugins/docops/README.md) for additional installation/build details.

Ray nodes receive no coordinator patch paths/source. Install patches/modules on every node, then set pluginPatchPath in EVALUATOR_NODE_CONFIG JSON, relative to node config. All patch contents must match; workers validate patch/plugin digests before execution.

Jobs coordinators also set EVALUATOR_PLUGIN_PATCH_PATH to installed matching patches inside containers. Relative paths use Jobs working directories; prefer absolute. Workers still use node pluginPatchPath. Submission --patch, coordinator, and workers must load matching versions.

### Transfer Component Configuration to Ray Nodes

`register(role, name, validate, factory, transport?)` argument5 declares `PluginConfigTransport`, exported at root. No Ray component-name list edits are needed. Example:

```ts
ctx.evaluator.register("benchmark", "my-records", validateConfig, createBenchmark, {
  nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" },
  containerPaths: [["defaults", "workdir"], ["taskProfiles", "*", "extraPaths", "*"]],
  validate(config) {
    // Validate only; no downloads, containers, or model requests.
    if (config.sourceKind === "local") throw new TypeError("Local input cannot be distributed");
  },
});
```

- `nodeLocal` declares top-level fields removed by senders. Receivers map `cache` to `<outputRoot>/cache/<role>/<name>`, `docker` to configured `dockerExecutable`, omitting absent Docker settings for validators to default.
- `secretFields` declares forbidden top-level credentials, e.g. hfToken. Dispatch/Jobs retries strip them; receivers reject incoming fields; components read node-local credentials. Saved/exported `${NAME}` references remain unexpanded.
- `containerPaths` declares exact absolute-container positions; `*` matches one object key/array index. Paths require canonical POSIX absolute syntax, excluding Windows/double slashes/..; adjacent/deeper fields are not implicitly allowed.
- Optional `validate` purely checks configuration after node-local removal, on both endpoints. Harbor rejects local sources/declares workdirs here.
- Installed plugins supply declarations; requests cannot. Undeclared absolute paths/cacheDir/dockerExecutable/auth fields/authenticated URLs remain rejected. Relative preinstalled resources use receiver experiment directories without automatic upload.
- Direct Ray/submission/Jobs coordinator/workers share rules; Local skips conversion. Transport declarations do not establish remote capability; sources/private data/runtimes still follow contracts.

## Verification Runtimes

Benchmarks needing helper Python processes or containers may implement `verificationRuntime: VerificationRuntime`, with the type exported from the package root. This is separate from solveEnv/verifyEnv. WorkBuddy helpers inspect task containers through RPC rather than replacing them. Pure scoring/task-local shell verification needs none.

- `materialize(task, signal, activity?)` prepares shared dependencies and JSON receipts without attempt containers. Batch/pipeline/Ray call before ready; no-plan calls before solving. `PreparedTask.verificationRuntime` stores receipts inaccessible to Solver. Progress excludes private tests.
- `prepare(task, receipt, { key, paths, signal, activity? })` creates attempt resources/VerificationRuntimeSession without rebuilding/downloading images. Release partial resources on failure; uncertain release throws CLEANUP_FAILED.
- Session `verify(result, environment, signal)` returns `VerifyResult`; core uses it when present, otherwise Benchmark.verify. `environment` follows shared/separate rules and may be null. Persistent `metadata` goes into `result.json` at `environments.verificationRuntime` and must contain only serializable runtime information.
- Framework `dispose` runs on success/failure/cancellation/late handles with independent cleanup signals. Cleanup errors are recorded, never swallowed as success. `recoverAttempts(keys, signal)` reclaims only specified resources on resume.

Composable Verifiers use `runtime: VerificationRuntime<JsonValue, VerificationEvidence>` with private descriptions. Harbor integrates lifecycle and retains reward configuration. harbor-python/HumanEval already use attempt-labeled immutable-ID containers with execution auto-pull disabled.

Factories access models/auth through `runtime.services` and explicit service names. Solvers use `bindSolverService(runtime)`; Verifiers `bindService(runtime, runtime.verifierService)` only for configured routes, both root exports. No top-level model/auth exists; Solver services are not implicit judge defaults. Ray workers accept `{ services }`, Jobs `serviceAuth` only; old single-model forms are rejected.
