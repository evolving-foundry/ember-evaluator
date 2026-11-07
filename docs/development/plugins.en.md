# Plugin Development and Loading

> English | [中文](./plugins.md)

Covers eight component interfaces, runnable metric plugins, explicit patches, and Ray deployment. Source commands/experiments paths are relative to the Evaluator root.

[Project home](../../README.md) · [User guide](../users/README.md)

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

Record definitions live in `src/plugins/benchmarks/definitions/`: task files convert/select scoring; `records.ts` validates/builds; `prompts.ts` stores prompts. `scoring/` groups matching/generative-choice/probability/model-judge/code execution; complex DROP algorithms may be separate. Reuse scoring rather than requiring a new `*-score.ts` per dataset. Scoring remains benchmark business logic, not automatically a Verifier because of filenames.


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

Example completed-task metric: create `experiments/plugins/completed-count.mjs`:

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


## Building and extending repository plugins

`pnpm build` scans `plugins/*/ember-plugin.json`, compiles and copies files to `dist/external-plugins/<id>`, and writes the complete `dist/external-plugins/index.json` catalog. Plugins without CLI commands are included. Core evaluation components stay in src/plugins and their dist/plugins output is never overwritten.

```json
{
  "id": "example",
  "entry": "./dist/index.js",
  "cli": "./dist/cli-register.js",
  "flags": [
    { "command": "run", "flag": "--example [url]", "description": "Enable example", "config": "url" }
  ],
  "build": {
    "tsconfig": "./tsconfig.json",
    "install": ["dist", { "from": "assets", "to": "dist/assets" }]
  }
}
```

ID must match the directory name. Version defaults to the host version. entry is the Cordis entry; optional cli loads CLI registrations. Omit build.tsconfig for precompiled JavaScript; otherwise compilation targets the plugin's dist directory. Required build.install accepts relative paths or from/to resource copies. Manifest paths remain valid after installation; escaping paths and symlinks are rejected.

When a plugin only adds options to an existing command, declare `flags` instead of shipping a CLI module: the host registers them from the manifest, `command` currently supports `run`, flags use `--name`, `--name <value>` or `--name [value]`, and `config` names the activation key written when the flag carries a value. `flags` and `cli` may be combined; conflict checks cover both. Use a `cli` module for dedicated subcommands or dynamic logic.

Plugins that need esbuild or other custom output may declare `build.script`, executed with the plugin directory as cwd; the script owns the `dist` output, so a declared `build.tsconfig` does not run `tsc` during the build and root `pnpm typecheck` covers those sources. Plugins loaded only through `--patch` declare `patch`, and the build copies `cordis.patch.yaml` into the installed directory.

The CLI module exports `registerCli(cli: PluginCliRegistrar)`, importing types from `ember-evaluator`:

```ts
export function registerCli(cli: PluginCliRegistrar): void {
  cli.addCommand({ name: "example", description: "Example tools", async run(argv, io, signal) {
    const { run } = await import("./command.js");
    return run(argv, io, signal);
  } });
  cli.extendCommand("run", {
    flags: "--example [url]", description: "Enable example",
    configure(value, activation) { activation.enable(typeof value === "string" ? { url: value } : {}); },
  });
}
```

The host discovers the catalog and explicit --patch, loads registrations, then strictly parses all arguments. Duplicate commands, flags and aliases fail instead of overriding builtins. Registration cannot start processes, access the network or open databases. Patch plugins may export registerCli from their Cordis entry without a manifest. Installed and patch plugin IDs must not collide.

`ctx.evaluator.registerStoreDecorator(name, validate, factory)` registers a factory returning a Store wrapper. Ownership is recorded by plugin ID; names may differ. Only activated plugins create wrappers. Validation precedes component factories. Use Cordis effects for cleanup, runtime.signal for cancellation, and preserve optional Store capabilities and return values.

SDK callers activate extensions with `overrides.plugins: [{ id, config }]`. Persistable JSON options must use environment references for credentials. manifest.json records pluginRuntime.plugins; resume/retry restore options and reject conflicting explicit options.

The tracer plugin owns `--tracer [url]` and `tracer serve/stop/status/logs`. SDK options accept tokenEnv instead of literal token credentials. Default data lives in .cache/tracer under the working directory. Ray Jobs sends portable options to the coordinator; workers register preinstalled modules for version checks without activating coordinator Store wrappers. Tracer mirrors imported remote evidence on the coordinator, not a live worker stream.

The checkout fingerprint includes manifested plugin sources and assets, excluding generated output, dependencies and caches. Tests under each manifested plugin's tests/**/*.test.ts are discovered automatically. Adding plugins requires no host source changes or per-plugin TypeScript/test include entries.


## Reference External Plugins with `--patch`

Create `cordis.patch.yaml` in a separate directory:

```yaml
- insert:
    - id: custom-metrics                    # Unique module ID for provenance and version records
      name: ./completed-count.mjs            # Module path relative to this patch directory
      # name may also be an installed npm package, resolved from the patch directory.
      # Patches currently support insert only; entries accept id and name.
```

Layout:

```text
experiments/
├── gsm8k.yaml
└── plugins/
    ├── cordis.patch.yaml
    └── completed-count.mjs
```

Change `gsm8k.yaml` `metrics` to:

```yaml
metrics:                       # Explicit lists replace defaults; include built-in metrics you want to retain
  - name: success-rate
  - name: duration
  - name: usage
  - name: completed-count      # Component name from register(), not the patch ID or module path
    # config: {}               # Component options go here; this example rejects nonempty options
```

Pass patches explicitly; omission loads built-ins only:

```bash
ember-evaluator run experiments/gsm8k.yaml --patch <path>/plugins/cordis.patch.yaml
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
