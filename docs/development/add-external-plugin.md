# 新增外部插件

> [English](./add-external-plugin.en.md) | 中文

这个例子用一个 JavaScript 文件新增指标 `external-completed-count`。准备三个文件即可。`completed-count.mjs` 写指标怎么计算，`cordis.patch.yaml` 告诉 Evaluator 加载哪个文件，`experiment.yaml` 选择要用的指标。

三个文件都放在 `.scratch/external-plugin-example/`。下文的命令在仓库根目录的 Bash 或 WSL 中运行，先按[安装指南](../users/installation.zh-CN.md)构建 Evaluator。

## 最小示例

### 1. 写插件文件

运行 `mkdir -p .scratch/external-plugin-example`，在该目录创建 `completed-count.mjs`。Evaluator 加载文件时会调用 `apply(ctx)`，这段代码把指标注册为 `external-completed-count`。

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

### 2. 指定要加载的文件

在同一目录创建 `cordis.patch.yaml`。这里的 `id` 是模块标识，`name: ./completed-count.mjs` 指向同目录的 JavaScript 文件。

```yaml
- insert:
    - id: example-metrics
      name: ./completed-count.mjs
```

### 3. 在实验里选中指标

复制一份 GSM8K 实验配置。

```bash
cp playbook/gsm8k/gsm8k-simpleagent.yaml .scratch/external-plugin-example/experiment.yaml
```

打开副本 `.scratch/external-plugin-example/experiment.yaml`，在文件末尾添加以下内容。`metrics` 和 `benchmark` 在同一级，`name` 填第 1 步注册的 `external-completed-count`。

```yaml
metrics:
  - name: external-completed-count
```

### 4. 确认插件已加载

运行 `inspect` 时把实验文件和 patch 一起传进去。命令里的模型设置只用于配置检查。

```bash
export MODEL_NAME=unused-example MODEL_ENDPOINT=http://127.0.0.1:1/v1 MODEL_API_KEY=fixture-only
node dist/cli.js inspect .scratch/external-plugin-example/experiment.yaml \
  --patch .scratch/external-plugin-example/cordis.patch.yaml
```

`inspect` 输出的 `experiment.metrics` 应包含 `external-completed-count`。如果提示 `unknown metrics plugin`，先检查 `--patch` 路径和 YAML 里填写的指标名。

## 接下来

要用 TypeScript 开发、按包名加载或部署到 Ray，查[接入外部插件](external-plugins.md)。
