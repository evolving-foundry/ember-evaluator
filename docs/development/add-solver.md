# 新增 Solver

> [English](./add-solver.en.md) | 中文

这个例子新增一个叫 `fixed-answer` 的内置 Solver。它把 YAML 里写好的答案返回给评测框架，然后用一道本地选择题跑完整流程。

需要改两处源码。新建 `src/plugins/solvers/fixed-answer.ts`，再在 `src/plugins/solvers/index.ts` 注册它。测试用的 CSV 和 YAML 都放在 `.scratch/solver-example/`。下文的命令在仓库根目录的 Bash 或 WSL 中运行，先按[安装指南](../users/installation.zh-CN.md)装好依赖。

## 最小示例

### 1. 写一个直接返回答案的 Solver

创建 `src/plugins/solvers/fixed-answer.ts`。`parseFixedAnswerConfig()` 只接收一个非空的 `answer` 字符串。`solve()` 返回这段文字，并保存两份文件，供评测框架记录本次执行。

```ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Solver } from "../../core/contracts/solver.js";

export function parseFixedAnswerConfig(value: unknown): { answer: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fixed-answer config must be an object");
  }
  if (!("answer" in value) || typeof value.answer !== "string" || value.answer.trim() === "" ||
      Object.keys(value).some(key => key !== "answer")) {
    throw new TypeError("fixed-answer config requires only a non-empty answer string");
  }
  return { answer: value.answer };
}

export function createFixedAnswerSolver(config: { answer: string }): Solver {
  return {
    requirements() { return []; },
    async solve(input, _session, context) {
      const { key, paths, signal } = context;
      signal.throwIfAborted();
      const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const event = (seq: number, type: string, data: object) =>
        JSON.stringify({ schemaVersion: 1, key, seq, at: new Date().toISOString(), type, data }) + "\n";
      await writeFile(join(paths.agent, "session.jsonl"), JSON.stringify({ taskId: input.id, answer: config.answer }) + "\n",
        { encoding: "utf8", mode: 0o600, signal });
      await writeFile(join(paths.agent, "trajectory.jsonl"),
        event(1, "start", { solver: "fixed-answer" }) + event(2, "end", { finalText: config.answer, usage }),
        { encoding: "utf8", mode: 0o600, signal });
      return { finalText: config.answer, usage };
    },
  };
}
```

### 2. 让 Evaluator 识别 `fixed-answer`

在 [`src/plugins/solvers/index.ts`](../../src/plugins/solvers/index.ts) 顶部加上这条导入。

```ts
import { createFixedAnswerSolver, parseFixedAnswerConfig } from "./fixed-answer.js";
```

在同一个文件已有的 `apply(ctx)` 函数里加上这一行。第二个参数 `fixed-answer` 就是下一步写进 YAML 的名字。

```ts
ctx.evaluator.register("solver", "fixed-answer", parseFixedAnswerConfig, createFixedAnswerSolver);
```

### 3. 准备一道本地题和实验配置

运行 `mkdir -p .scratch/solver-example`。在该目录创建 `gpqa.csv`，写入以下两行。

```csv
Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2,Incorrect Answer 3
What is 6 times 7?,42,36,40,49
```

在同一目录创建 `experiment.yaml`。`benchmark.config.localPath` 指向刚才的 CSV。`benchmark.solver.name` 选中第 2 步注册的 Solver，`benchmark.solver.config.answer` 是它会返回的文字。

```yaml
services:
  default:
    model: unused-example
    base_url: http://127.0.0.1:1/v1
    api_key: ${EXAMPLE_SOLVER_KEY}
benchmark:
  name: gpqa
  config:
    localPath: ./gpqa.csv
  solver:
    name: fixed-answer
    service: default
    config:
      answer: "Answer: A"
environment: local
run:
  maxTasks: 1
output:
  directory: ./results
```

### 4. 检查配置，再跑一道题

以下命令使用占位模型和认证。本例直接返回固定答案，不发出模型请求。

```bash
export EXAMPLE_SOLVER_KEY=fixture-only
pnpm typecheck
pnpm build
node dist/cli.js inspect .scratch/solver-example/experiment.yaml
node dist/cli.js run .scratch/solver-example/experiment.yaml
```

怎么知道跑通了？

- `inspect` 输出里的 `experiment.benchmark.solver.name` 是 `fixed-answer`。
- `run` 输出结果目录。在其中找到本次 attempt 的 `result.json`，确认 `solve.finalText` 是 `Answer: A`、`executionStatus` 是 `completed`、`scoreStatus` 是 `valid`。GPQA 会打乱选项，分数为 0 也可以通过这次检查。
- 在同一个 attempt 目录确认有 `agent/trajectory.jsonl` 和 `agent/session.jsonl`。

想确认配置校验生效，可以把 `answer` 换成数字，再跑一次 `inspect`，预期会报错。

## 接下来

要接入真实模型、安装运行时或启动子进程，查 [Solver 开发参考](solver-development.md)。
