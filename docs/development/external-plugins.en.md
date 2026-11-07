# Integrating External Plugins

> English | [中文](./external-plugins.md)

This guide starts from an empty directory and walks through implementing and building a Metrics component in an independent TypeScript project, then verifying it in an experiment. To write another role, choose a contract from [Component Types](plugins.en.md#component-types) and replace the implementation and registration in step 2. For a Solver, follow [Solver in a standalone project](#solver-in-a-standalone-project). [Add an external plugin](add-external-plugin.en.md) has a single-file JavaScript example. For an existing JavaScript module, start at step 3.

External plugins do not require changes to Evaluator's `src/plugins/index.ts`. The plugin registers components in `apply(ctx)`, the command loads its module through `--patch`, and the experiment selects components by registered name. Installing a package or editing the experiment alone does not load it.

## 1. Create an independent project

Install and build Evaluator using the [installation guide](../users/installation.md) and the Node.js/pnpm versions declared in its `package.json`. This example uses:

```text
work/
├── Ember-Evaluator/       # Built; contains dist/index.d.ts and dist/cli.js
└── evaluator-metrics/          # Run all commands below from this plugin project
    ├── package.json
    ├── tsconfig.json
    ├── src/context.ts
    ├── src/index.ts
    ├── cordis.patch.yaml
    └── experiment.yaml
```

Create `package.json`:

```json
{
  "name": "@example/evaluator-metrics",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json" },
  "devDependencies": {
    "ember-evaluator": "link:../Ember-Evaluator",
    "@deepseek-ai/cordis": "4.0.2",
    "@types/node": "24.13.5",
    "typescript": "7.0.2"
  }
}
```

Adjust the `link:` path relative to your plugin project. This uses types from a local Evaluator build and does not assume a public npm release. The example imports types only, so these packages are development dependencies. A plugin that calls Evaluator exports at runtime must also provide a compatible Evaluator dependency in its deployment.

Keep `exports.default`: the current loader uses `createRequire().resolve()` to locate a package before importing it as ESM. A package exposing only `exports.import` may fail package-name resolution.

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

## 2. Implement and compile the plugin

Use component types exported from the package root. Cordis's `Context` type does not declare the `evaluator` service that Evaluator injects. Declare the `register()` signature used by these examples in `src/context.ts`. The `inject` declaration tells Cordis which service the plugin needs at runtime.

```ts
import type { Context } from "@deepseek-ai/cordis";
import type { PluginConfigValidator, PluginFactory, PluginRole } from "ember-evaluator";

export type EvaluatorPluginContext = Context & {
  evaluator: {
    register<R extends PluginRole, T>(
      role: R,
      name: string,
      validate: PluginConfigValidator<T>,
      factory: PluginFactory<R, T>,
    ): () => Promise<void>;
  };
};
```

Create `src/index.ts` with a metric that counts tasks with valid scores.

```ts
import type { Metrics } from "ember-evaluator";
import type { EvaluatorPluginContext } from "./context.js";

export const inject = ["evaluator"];

export function apply(ctx: EvaluatorPluginContext): void {
  ctx.evaluator.register(
    "metrics",
    "valid-count",
    (config: unknown) => {
      if (config === null || typeof config !== "object" ||
          Array.isArray(config) || Object.keys(config).length !== 0) {
        throw new TypeError("valid-count does not accept configuration fields");
      }
      return {};
    },
    (): Metrics => ({
      name: "valid-count",
      async compute(snapshot) {
        return {
          valid: snapshot.records.filter(record => record.scoreStatus === "valid").length,
          selected: snapshot.run.taskIds.length,
        };
      },
    }),
  );
}
```

`valid` counts valid scoring outcomes, not correct answers. Performance evaluations use `scoreStatus: not-applicable` and are excluded. The metric reads saved snapshots only, needs no model key, and works when rebuilding reports offline.

Install and build for the first time:

```bash
pnpm install
pnpm build
```

Commit the plugin's own `pnpm-lock.yaml` after the first installation; use `pnpm install --frozen-lockfile` thereafter. Rebuild after editing TypeScript. Evaluator rejects `.ts` entry points, and its root build does not compile this independent project.

Other components use the same `register(role, name, validate, factory)` API. Import public types from the package root, not `ember-evaluator/src/...`. Keep `validate` free of resource allocation. Factories can resolve experiment-relative paths with `runtime.resolvePath()`. Register long-lived resources with the plugin scope, for example `ctx.effect(() => () => resource.close())`; release attempt resources through their session contracts. See [component contracts and lifecycles](plugins.en.md).

### Solver in a standalone project

Use the project structure from step 1. Save the [fixed-answer Solver implementation](add-solver.en.md#minimal-example) as `src/fixed-answer.ts` in the standalone project. Change the Solver type import to `import type { Solver } from "ember-evaluator"`. Use this `src/index.ts` and run `pnpm build` in the standalone project.

```ts
import type { EvaluatorPluginContext } from "./context.js";
import { createFixedAnswerSolver, parseFixedAnswerConfig } from "./fixed-answer.js";

export const inject = ["evaluator"];

export function apply(ctx: EvaluatorPluginContext): void {
  ctx.evaluator.register("solver", "external-fixed-answer", parseFixedAnswerConfig, createFixedAnswerSolver);
}
```

Follow step 3 to write a file-based patch with `name` set to `./dist/index.js` and an `id` such as `custom-solver`. Save `experiment.yaml` and `gpqa.csv` from the Solver example in the standalone project. Set `benchmark.solver.name` to `external-fixed-answer` in the YAML and set `EXAMPLE_SOLVER_KEY` as shown in the example. Run these commands in the standalone project.

```bash
ember-evaluator inspect experiment.yaml --patch cordis.patch.yaml
ember-evaluator run experiment.yaml --patch cordis.patch.yaml
```

`inspect` should show that the experiment selects `external-fixed-answer`. Follow the [fixed-answer example](add-solver.en.md#minimal-example) to check the score and artifacts.

## 3. Choose one module loading method

**A: Load a compiled local file.** Create `cordis.patch.yaml`:

```yaml
- insert:
    - id: custom-metrics
      name: ./dist/index.js
```

**B: Load by package name.** This example can resolve its own name from `package.json`. Replace the patch with the following; do not load both variants:

```yaml
- insert:
    - id: custom-metrics
      name: "@example/evaluator-metrics"
```

For a package supplied by another team, install it and its runtime dependencies in the **project containing the patch**, then use its actual name, for example with `pnpm add <plugin-package>@<pinned-version>`. `@example/evaluator-metrics` is a local example, not a public package to download. If the patch lives in another experiment project, the package must resolve from that project. A global installation or an installation only in Evaluator's repository is insufficient.

The three names serve different purposes:

| Location | Example | Meaning |
| --- | --- | --- |
| Patch `id` | `custom-metrics` | Module identity used for version records; unique within the patch |
| Patch `name` | `./dist/index.js` or `@example/evaluator-metrics` | Module to import |
| `register()` and experiment `name` | `valid-count` | Selected component; unique within its role |

One module can register several components. Patches currently support only `insert`, with `id` and `name` entries. Duplicate registrations cannot replace built-ins; use a new registration name and select it in YAML.

## 4. Select the component in an experiment

Save this as `experiment.yaml`. Set `MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY` as described in the [quick start](../users/quick-start.md).

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: simpleagent
    service: default
environment: local
scheduler:
  name: local
  concurrency: 1
metrics:
  - name: success-rate
  - name: duration
  - name: usage
  - name: valid-count
    config: {}
run:
  maxTasks: 1
output:
  directory: ./results
```

An explicit `metrics` list replaces the defaults, so retain any built-in metrics you need. Other roles use these field paths, each containing its own `{ name, config }` selection:

| Role | User YAML location |
| --- | --- |
| `benchmark` | `benchmark` |
| `solver` / `verifier` | `benchmark.solver` / `benchmark.verifier` |
| `environment` / `scheduler` / `store` / `reporter` | Same-named top-level field |
| `metrics` | Entry in the top-level `metrics` list |

Select the Solver model service through `benchmark.solver.service`; a model-backed Verifier uses `benchmark.verifier.service`. Private configuration belongs in the component's `config`, not in the patch. For Profile defaults, see [Benchmark development](benchmarks.en.md).

## 5. Validate loading and run

Register `ember-evaluator` using the [installation guide](../users/installation.md#register-the-global-cli), then run from the plugin project:

```bash
ember-evaluator inspect experiment.yaml --patch cordis.patch.yaml
ember-evaluator run experiment.yaml --patch cordis.patch.yaml --dry-run
ember-evaluator run experiment.yaml --patch cordis.patch.yaml
```

- `inspect` validates the experiment configuration, registered component names, and plugin options. It prints the resolved experiment configuration and redacted network settings.
- `--dry-run` also resolves the dataset, enumerates tasks, and selects them; it may download data. It does not call the Solver or validate metric computation, report rendering, and every runtime capability.
- A real run calls the model. Inspect `metrics.valid-count` in the output run's `metrics.json`. This example selects one task; `valid` depends on its scoring status. The built-in Markdown reporter does not guarantee display of arbitrary custom metrics, so verify the JSON first.

`--patch` is relative to the process working directory. Module paths and package resolution are relative to the patch directory. Experiment output and factory paths resolved by `resolvePath()` are relative to the experiment YAML. Omitting `--patch` loads only built-ins; adjacent patch files are not discovered automatically.

Resume with the same explicit patch:

```bash
ember-evaluator run experiment.yaml --patch cordis.patch.yaml --resume <run-id>
ember-evaluator report results/<run-id>
```

`report` does not accept `--patch`. It loads the original Metrics/Reporter providers from saved metadata without solving again. Keep the original plugin installation and resolvable paths. Moving results does not copy plugins or rewrite saved plugin paths.

Local-file plugins currently record only the entry-file digest; package-name plugins prefer the package version. This is not a full dependency-content check. Pin dependency locks and bump package versions when logic or assets change. For file loading, bundling executable code into one entry can improve coverage, but external assets must still be pinned. Preserve the original deployment for resume and start a new run for a new version.

## 6. SDK and Ray integration

The SDK uses the same experiment and patch through `patchPath`:

```ts
import { Evaluator } from "ember-evaluator";

const result = await new Evaluator().run({
  configPath: "./experiment.yaml",
  patchPath: "./cordis.patch.yaml",
});
```

Both paths are relative to the calling process working directory. See the [SDK guide](../users/sdk.md) for results, errors, and cancellation.

Ray does not automatically upload plugin source, `node_modules`, or the submitter's local patch path:

1. Install compatible Evaluator versions, identical plugin builds, and runtime dependencies on the submitter, Jobs coordinator, and every execution node.
2. Use patches with identical content across hosts. Prefer package names or consistent relative directory layouts over submitter-specific absolute paths.
3. Set `pluginPatchPath` in each execution node's JSON selected by `EVALUATOR_NODE_CONFIG`. Relative values resolve from that JSON file's directory.
4. For Ray Jobs, also set `EVALUATOR_PLUGIN_PATCH_PATH` on the coordinator to its preinstalled patch. The submission command still needs `--patch`.
5. Declare cache paths, Docker executable paths, container paths, and sensitive fields through `PluginConfigTransport` where needed. See [plugin deployment](plugins.en.md) and [concurrency and environment preparation](../users/concurrency.md).

Local loading does not prove Ray compatibility. Plugins must also satisfy remote resource, transfer, cancellation, and preparation contracts, without assuming that workers can read submitter-local files.

## Common errors and acceptance checks

| Symptom | What to check |
| --- | --- |
| `unknown ... plugin` | Was `--patch` provided? Does YAML use the registered component name? Does `apply` register the selected role? |
| `must be compiled to JavaScript` | Build first and point the patch at `.js` / `.mjs`, not `.ts` |
| Package missing or `ERR_PACKAGE_PATH_NOT_EXPORTED` | Install from the patch project; check build output and resolvable `exports.default` / `require` conditions |
| `duplicate ... registration` | The same module may be loaded twice, or its component name collides with another plugin or built-in |
| `invalid ... plugin config` | Inspect the plugin validator; private parameters belong in experiment `config` |
| Resume/node version mismatch | Restore the original deployment and patch, or start a new run; do not bypass checks |
| Plugin missing during report rebuild | Check the original patch project, compiled files, and dependencies |

Before delivery, verify compilation, patch loading, rejection of unknown fields, a controlled run, custom result fields, and offline report rebuilding. Resource-owning plugins also need failure and cancellation cleanup checks; Ray deployment requires separate node validation. See the independently packaged [DocOps plugin](../../plugins/docops/README.md) and [plugin error handling](diagnostics.en.md).
