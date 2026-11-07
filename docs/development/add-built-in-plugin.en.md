# Add a Built-in Component

> English | [中文](./add-built-in-plugin.md)

This example adds a built-in metric called `completed-count`. It reads the results and counts records whose `executionStatus` is `completed`.

You will edit two source files. Create `src/plugins/metrics/completed-count.ts` and register it in `src/plugins/metrics/index.ts`. Use a copy of an existing experiment for the configuration. Follow the [installation guide](../users/installation.md) to install dependencies, then run these commands from the repository root in Bash or WSL.

## Minimal example

### 1. Count completed records

Create `src/plugins/metrics/completed-count.ts`. `compute()` receives the evaluation results and returns the number of completed records in `completed`.

```ts
import type { Metrics } from "../../core/contracts/metrics.js";

export function createCompletedCount(): Metrics {
  return {
    name: "completed-count",
    async compute(snapshot) {
      return { completed: snapshot.records.filter(record => record.executionStatus === "completed").length };
    },
  };
}
```

### 2. Register the metric name

Add this import at the top of [`src/plugins/metrics/index.ts`](../../src/plugins/metrics/index.ts).

```ts
import { createCompletedCount } from "./completed-count.js";
```

In the same file, find `empty` inside `apply(ctx)` and add this line after its definition. The `empty` validator accepts an empty configuration for the metric.

```ts
ctx.evaluator.register("metrics", "completed-count", empty, createCompletedCount);
```

### 3. Select the metric in the experiment

Copy the GSM8K experiment configuration.

```bash
mkdir -p .scratch/built-in-plugin-example
cp playbook/gsm8k/gsm8k-simpleagent.yaml .scratch/built-in-plugin-example/experiment.yaml
```

Append the following to `.scratch/built-in-plugin-example/experiment.yaml`. Put `metrics` at the same indentation level as `benchmark`.

```yaml
metrics:
  - name: completed-count
```

### 4. Check that Evaluator finds the metric

Build and run `inspect`. The placeholder model settings are for the configuration check.

```bash
export MODEL_NAME=unused-example MODEL_ENDPOINT=http://127.0.0.1:1/v1 MODEL_API_KEY=fixture-only
pnpm build
node dist/cli.js inspect .scratch/built-in-plugin-example/experiment.yaml
```

The output should include `completed-count` under `experiment.metrics`. After a run with real model settings, check `metrics.completed-count.completed` in `metrics.json`.

## Next steps

See [Plugin development and loading](plugins.en.md#add-a-built-in-component) to add a Benchmark, Environment, or another type of built-in component.
