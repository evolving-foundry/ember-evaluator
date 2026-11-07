# 新增内置组件

> [English](./add-built-in-plugin.en.md) | 中文

这个例子新增一个叫 `completed-count` 的内置指标。它读取已有结果，数一数有多少条记录的 `executionStatus` 是 `completed`。

只改两处源码。新建 `src/plugins/metrics/completed-count.ts`，再在 `src/plugins/metrics/index.ts` 注册它。实验配置用现有示例的副本。下文的命令在仓库根目录的 Bash 或 WSL 中运行，先按[安装指南](../users/installation.zh-CN.md)装好依赖。

## 最小示例

### 1. 统计已完成的记录

创建 `src/plugins/metrics/completed-count.ts`。`compute()` 接收评测结果，返回 `{ completed: 数量 }`。

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

### 2. 注册指标名

在 [`src/plugins/metrics/index.ts`](../../src/plugins/metrics/index.ts) 顶部加上这条导入。

```ts
import { createCompletedCount } from "./completed-count.js";
```

在同一个文件的 `apply(ctx)` 里，找到现有的 `empty` 函数，在它后面加上这一行。`empty` 表示这个指标只接受空配置。

```ts
ctx.evaluator.register("metrics", "completed-count", empty, createCompletedCount);
```

### 3. 在实验里选中指标

复制一份 GSM8K 实验配置。

```bash
mkdir -p .scratch/built-in-plugin-example
cp playbook/gsm8k/gsm8k-simpleagent.yaml .scratch/built-in-plugin-example/experiment.yaml
```

打开副本 `.scratch/built-in-plugin-example/experiment.yaml`，在文件末尾添加以下内容。`metrics` 和 `benchmark` 在同一级。

```yaml
metrics:
  - name: completed-count
```

### 4. 确认配置能找到指标

构建后运行 `inspect`。命令里的模型设置只用于配置检查。

```bash
export MODEL_NAME=unused-example MODEL_ENDPOINT=http://127.0.0.1:1/v1 MODEL_API_KEY=fixture-only
pnpm build
node dist/cli.js inspect .scratch/built-in-plugin-example/experiment.yaml
```

`inspect` 输出的 `experiment.metrics` 应包含 `completed-count`。用实际模型配置完成一次实验后，在 `metrics.json` 查看 `metrics.completed-count.completed`。

## 接下来

要新增 Benchmark、Environment 或其他类型的内置组件，查[插件开发与加载](plugins.md#新增内置组件)。
