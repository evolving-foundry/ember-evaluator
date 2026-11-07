# Source Architecture and Execution Flow

> English | [中文](./architecture.md)

This guide describes current module responsibilities, calls, and resource ownership. Update it with the implementation. See [AGENTS.md](../../AGENTS.md) for repository rules, [plugin development](plugins.en.md) for component contracts and loading, and [Benchmark development](benchmarks.en.md) for adding workloads.

## Directory Responsibilities

| Location | Behavior and entry points |
| --- | --- |
| [src/index.ts](../../src/index.ts) | Explicit public API and type exports; internal modules import their implementations directly |
| [src/cli.ts](../../src/cli.ts), [cli/](../../src/cli) | Process signals, command definitions and dispatch, terminal progress, and exit codes |
| [application/](../../src/application) | Run, report, warmup, retry, and diagnostic operations; component creation and disposal; local execution or Ray Jobs deployment |
| [config/](../../src/config) | YAML loading, environment and Profile expansion, validation, and redaction; no Cordis Context or runtime component creation |
| [core/](../../src/core) | Component contracts, source locking, task selection, preparation, scheduling, attempts, recovery, results, and artifacts |
| [plugins/](../../src/plugins) | Implementations of Benchmark, Verifier, Environment, Solver, Metrics, Reporter, Store, and Scheduler |
| [runtimes/](../../src/runtimes) | Installation recipes, bridges, protocols, and assets for specific programs such as Pi, DSH, AgentBundle, and AgentX |
| [infrastructure/](../../src/infrastructure) | Process, shell, container, network, download, installation lock, IPC, transfer, and provenance I/O |

Within core, `contracts/` defines interfaces, `execution/` runs evaluations, `preparation/` prepares tasks, `recovery/` handles resume and retry eligibility, `selection/` selects tasks, `results/` owns result/source rules, and `artifacts/` handles file manifests and trajectories. See the [repository directory tree](../../AGENTS.md#仓库目录结构).

Config reads and parses configuration without loading plugin modules. [plugin-patch.ts](../../src/config/plugin-patch.ts) reads and validates patches and computes their digests; [load-module.ts](../../src/application/plugins/load-module.ts) resolves modules relative to the patch directory, reads package versions or hashes local files, and performs dynamic imports. Configuration file reads still involve I/O, so config is not entirely pure. Core also performs file I/O and invokes component I/O through contracts; its boundary excludes application assembly and concrete component dependencies. Infrastructure can use Evaluator contracts but does not decide scores, retry eligibility, or scheduling policy.

## Allowed Source Dependencies

This table covers repository source dependencies, not Node built-ins or third-party packages.

| Importing layer | Allowed directories |
| --- | --- |
| core | core |
| config | config, core |
| infrastructure | infrastructure, core, allowlisted config modules |
| runtimes | runtimes, infrastructure, core, allowlisted config modules |
| plugins | plugins, runtimes, infrastructure, core, allowlisted config modules |
| application | application, config, core, plugins, runtimes, infrastructure |
| cli | cli, application, core |

`src/index.ts` and `src/cli.ts` are public export/process entries exempt from the directory table. Other internal modules cannot import the package root or self-import `ember-evaluator` to bypass the rules. Config, infrastructure, and runtimes also cannot import `core/execution/`.

Run `pnpm check:dependencies`. Rules and the config allowlist live in [check-dependencies.mjs](../../scripts/check-dependencies.mjs); [dependency-baseline.json](../../scripts/dependency-baseline.json) must remain empty. Adding a config file does not automatically permit other layers to import it.

The checker covers static/type imports, re-exports, string-literal dynamic imports, resolvable require calls, missing relative modules, and executable import cycles. Type-only edges obey directory rules but do not form initialization cycles. Additional review is required because:

- Cross-role imports within plugins are allowed; the checker cannot establish whether they serve a valid purpose.
- The config allowlist does not prove freedom from side effects.
- Computed module addresses, code under `assets/`, Python dependencies, and resource URLs are not fully covered.
- Asset copying, process startup, cancellation, and cleanup require build, integration, and distribution checks; zero dependency violations do not establish those behaviors.

## Execution and Resource Ownership

CLI `run` and SDK `Evaluator.run()` use `executeExperiment` in [application/run.ts](../../src/application/run.ts). The ordinary execution path is:

1. [plugins/open-registry.ts](../../src/application/plugins/open-registry.ts) creates a Cordis Context and registers built-in and explicit patch plugins.
2. [application/config.ts](../../src/application/config.ts) supplies that registry's Profiles and validators to config. [plugins/create-components.ts](../../src/application/plugins/create-components.ts) calls `createRunComponents(registry, config, directory)` using the same registry.
3. [run-engine.ts](../../src/application/run-engine.ts) supplies retry controls and run identity loading, then calls [core/execution/engine.ts](../../src/core/execution/engine.ts).
4. Core handles sources, selection, recovery, and preparation, schedules through Scheduler, and executes attempts through [run-task.ts](../../src/core/execution/run-task.ts).
5. Application saves metrics/reports and closes the registry on exit, releasing component resources through Cordis effects, including after failure or cancellation.

`runTask()` prepares the task, advances through steps, archives evidence, and saves the result. [run-attempt-step.ts](../../src/core/execution/run-attempt-step.ts) solves, collects, transfers, and verifies one step. On failure it recovers artifacts before the solve environment closes. [attempt-resources.ts](../../src/core/execution/attempt-resources.ts) opens and closes environment sessions, prepared solvers, and private verifiers, and switches the solve environment between phases. A multi-step attempt closes the current step's private verifier and separate verification environment before archiving its evidence and reusing the solve environment for the next step.

`createRunComponents` and `createBenchmark` require an existing registry and never open or close it. The former returns `RunComponents` without `dispose()`; the latter returns a Benchmark directly. The registry owns factory resources, including resources allocated before an assembly failure, and its owner closes it in `finally`.

Public [bootstrap](../../src/application/plugins/bootstrap.ts) opens its own registry, closes it on failure, and returns `BootstrappedComponents` (component fields plus `dispose()`) on success. Its signature is `bootstrap(config, directory, patchPath?, onWarning?, imageConfigFingerprint?)`. The caller invokes the returned `dispose()` in `finally`; the registry handles repeated disposal.

`executeExperiment` closes its registry, including one transferred through the internal `execution` option. `executeWarmup` closes registries it opens; the Jobs entry closes a registry lent through `execution`. Preview, diagnosis, and Ray worker entries close their registries on exit. The worker execution function requires a registry and does not perform a no-op component disposal before uploading results. Public `runEngine` closes only the retry controls it creates; it does not open a registry, replace components, or close caller resources.

Benchmark prepares public input and private verification material. Solver receives only public tasks and an execution environment; Benchmark.verify or a private verification runtime scores the result; Store saves results and artifacts. `Benchmark.prepare()` runs before environment creation. Arbitrary additional lifecycle stages after environment startup require contract changes; see [Benchmark lifecycle limits](benchmarks.en.md#limits-for-future-memory-evaluation).

Offline reports use [application/report/](../../src/application/report) to load the Metrics and Reporter registration entries separately, read saved results, and invoke the selected components without loading the full built-in registration entry or running Solver again. Third-party reporting components use the same loadPluginModule function and retain checks against their saved plugin versions. Evidence format changes require checking readers, resume, Metrics, and Reporter together.

## Retry, Ray, and Docker

Within Engine, `admitRetryRequests` reads results, checks eligibility, reserves queue slots, and fills request bindings. `prepareRetryTask` replans and prepares dependencies for a new attempt. The internal queue carries the job and its preparation result together. The executor uses the attempt ID to retrieve that result and distinguish on-demand preparation, a task description, ready dependencies, or failed preparation. Pipeline readiness times belong to the corresponding attempt. [Preparation state types](../../src/core/preparation/task-preparation.ts)

The public Scheduler still receives `TaskJob`. Ray workers retain their preparation receipts and validate them before handing a job with ready dependencies to the executor.

[application/retry-control/mailbox.ts](../../src/application/retry-control/mailbox.ts) owns request files, locks, transactions, and IPC; core owns eligibility and queue reservations. The handoff contract is [core/contracts/retry-control.ts](../../src/core/contracts/retry-control.ts). Online retry requests reserve tasks, persist request state and attempt bindings, then `commit` admission only after persistence succeeds. `finally release` releases reservations. Failed persistence must not leave tasks queued; repeated requests must not schedule duplicates. Shutdown stops accepting requests and waits for in-flight transactions before closing the channel.

| Operation | Implementation |
| --- | --- |
| Submit/follow Ray Jobs and download remote results | `application/ray/`, using `infrastructure/ray/` clients |
| Dispatch attempts to Ray nodes | `plugins/schedulers/ray/`, using Ray protocols and the Python driver |
| Load node plugins and execute tasks | `application/ray/node-worker.ts`, using application assembly and core execution |
| Prepare Docker images, runtimes, and sessions | `plugins/environments/docker/environment.ts` |
| Execute, transfer, switch phases, and close a session | `plugins/environments/docker/session.ts` |
| Shared Docker commands, image operations, and build tools | `infrastructure/containers/` |

Ray Jobs deployment and RayScheduler task dispatch operate at different levels. Jobs entries call application operations directly rather than going through CLI argument parsing. Docker preparation still contains several image strategies; they are not each implemented as separate modules.

Docker's `prepareObserved` calls specific functions for receipt reading, image checks, log mounts, launch options, file staging, and execution users. `DockerPreparationReceipt` names the existing receipt fields. Gateway, Compose project, and container handles remain in the outer function, whose single `catch` cleans up failed preparation. Gateway cleanup still runs after a Compose cleanup failure, and both the original and cleanup errors are retained.

## Benchmarks and Plugin Registration

Benchmarks use `agent-harness/`, `inference-engine/`, and `operator/`, each with its own Profiles and registration `index.ts`. These categories add no YAML category field and no category branches to core execution. See [where to add behavior](benchmarks.en.md#where-to-add-new-behavior).

[plugins/index.ts](../../src/plugins/index.ts) composes registration entries. Benchmark, Solver, Environment, Verifier, Store, and Scheduler have their own entries; Metrics and Reporter use [metrics/index.ts](../../src/plugins/metrics/index.ts) and [reporters/index.ts](../../src/plugins/reporters/index.ts) respectively. External plugins use explicit `--patch` loading; omitting it does not scan a default directory. See [plugin development](plugins.en.md).

A feature can span roles. AgentX input/evidence lives in `plugins/benchmarks/inference-engine/agentx/`, execution calls in `plugins/solvers/agentx-replay.ts`, installation/bridging in `runtimes/agentx/`, and metrics/reporting in their respective roles. `evidence/` parses saved results directly without importing registration entries, installers, or samplers; shared versions come from the I/O-free `runtimes/agentx/versions.ts`.

At build time, [build-plugins.mjs](../../scripts/build-plugins.mjs) scans `plugins/*/ember-plugin.json` at the repository root, builds the declared plugins, and installs their output and patches under `dist/plugins/<id>/`. At runtime, an explicit patch loads these plugins. The manifest controls build output, and the host defines CLI commands.

## Build, Distribution, and Maintenance

After TypeScript compilation, [package-runtime.mjs](../../scripts/package-runtime.mjs) copies Profiles, Python, runtime assets, and licenses, then generates process entries and integrity manifests. Source has no `adapters/`; a few legacy paths in the package are generated for existing deployments. See [published process entries](plugins.en.md#published-process-entries) for supported paths and installed-package checks.

Pi packaging rewrites only the runner's dependency copies. Preparation modules retain their canonical dependencies and resource locations. The compatibility directory contains standalone dependencies and its own manifest. The packaging script explicitly copies built-in Benchmark Profiles and assets. Compatibility files and repository plugin output are in place before the package digest is calculated.

For cross-module changes, run dependency checks, type checks, and relevant tests. Build/runtime asset changes also require a build and actual installed-package validation. See [plugin development](plugins.en.md), [runtime validation](runtime-validation.en.md), and [repository development rules](../../AGENTS.md#开发流程) for component and real-environment checks.

Update both language versions when responsibilities, calls, or ownership change. Component details belong in plugin/Benchmark guides; user operations belong in user guides. Dated design/task records retain decisions and validation evidence, but must not be the only architecture reference.
