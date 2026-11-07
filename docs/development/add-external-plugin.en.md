# Add an External Plugin

> English | [中文](./add-external-plugin.md)

This example adds a metric called `external-completed-count` using a single JavaScript file. You need three files. `completed-count.mjs` defines the calculation, `cordis.patch.yaml` tells Evaluator which file to load, and `experiment.yaml` selects the metric.

Put all three files under `.scratch/external-plugin-example/`. Follow the [installation guide](../users/installation.md) to build Evaluator, then run the commands below from the repository root in Bash or WSL.

## Minimal example

### 1. Write the plugin file

Run `mkdir -p .scratch/external-plugin-example` and create `completed-count.mjs` in that directory. Evaluator calls `apply(ctx)` when it loads the file, and this function registers the metric as `external-completed-count`.

```js
export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.evaluator.register("metrics", "external-completed-count", config => {
    if (config === null || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 0) {
      throw new TypeError("external-completed-count accepts no configuration fields");
    }
    return {};
  }, () => ({
    name: "external-completed-count",
    async compute(snapshot) {
      return { completed: snapshot.records.filter(record => record.executionStatus === "completed").length };
    },
  }));
}
```

### 2. Tell Evaluator which file to load

Create `cordis.patch.yaml` in the same directory. The `id` identifies the module. `name: ./completed-count.mjs` points to the JavaScript file next to the patch.

```yaml
- insert:
    - id: example-metrics
      name: ./completed-count.mjs
```

### 3. Select the metric in the experiment

Copy the GSM8K experiment configuration.

```bash
cp playbook/gsm8k/gsm8k-simpleagent.yaml .scratch/external-plugin-example/experiment.yaml
```

Append the following to `.scratch/external-plugin-example/experiment.yaml`. Put `metrics` at the same indentation level as `benchmark` and use `external-completed-count`, the name registered in step 1.

```yaml
metrics:
  - name: external-completed-count
```

### 4. Check that the plugin loads

Pass both the experiment file and the patch to `inspect`. The placeholder model settings are for the configuration check.

```bash
export MODEL_NAME=unused-example MODEL_ENDPOINT=http://127.0.0.1:1/v1 MODEL_API_KEY=fixture-only
node dist/cli.js inspect .scratch/external-plugin-example/experiment.yaml \
  --patch .scratch/external-plugin-example/cordis.patch.yaml
```

The output should include `external-completed-count` under `experiment.metrics`. If you see `unknown metrics plugin`, check the `--patch` path and the metric name in the YAML first.

## Next steps

See [Integrating external plugins](external-plugins.en.md) to develop in TypeScript, load plugins by package name, or deploy to Ray.
