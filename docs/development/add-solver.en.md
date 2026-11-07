# Add a Solver

> English | [中文](./add-solver.md)

This example adds a built-in Solver called `fixed-answer`. It returns an answer from YAML and runs the full evaluation on one local multiple-choice question.

You will edit two source files. Create `src/plugins/solvers/fixed-answer.ts` and register it in `src/plugins/solvers/index.ts`. Put the test CSV and YAML under `.scratch/solver-example/`. Follow the [installation guide](../users/installation.md) to install dependencies, then run the commands below from the repository root in Bash or WSL.

## Minimal example

### 1. Write the Solver

Create `src/plugins/solvers/fixed-answer.ts`. `parseFixedAnswerConfig()` accepts one non-empty `answer` string. `solve()` returns that text and saves two files that record this execution.

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

### 2. Register the name `fixed-answer`

Add this import at the top of [`src/plugins/solvers/index.ts`](../../src/plugins/solvers/index.ts).

```ts
import { createFixedAnswerSolver, parseFixedAnswerConfig } from "./fixed-answer.js";
```

Add this line inside the existing `apply(ctx)` function in the same file. The second argument, `fixed-answer`, is the name you will use in YAML.

```ts
ctx.evaluator.register("solver", "fixed-answer", parseFixedAnswerConfig, createFixedAnswerSolver);
```

### 3. Add one local question and an experiment file

Run `mkdir -p .scratch/solver-example`. Create `gpqa.csv` in that directory with these two lines.

```csv
Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2,Incorrect Answer 3
What is 6 times 7?,42,36,40,49
```

Create `experiment.yaml` in the same directory. `benchmark.config.localPath` points to the CSV. `benchmark.solver.name` selects the Solver you registered, and `benchmark.solver.config.answer` is the text it will return.

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

### 4. Check the configuration and run one question

The commands use placeholder model settings and credentials. This Solver returns the fixed answer without making a model request.

```bash
export EXAMPLE_SOLVER_KEY=fixture-only
pnpm typecheck
pnpm build
node dist/cli.js inspect .scratch/solver-example/experiment.yaml
node dist/cli.js run .scratch/solver-example/experiment.yaml
```

Check these results.

- The `inspect` output shows `fixed-answer` at `experiment.benchmark.solver.name`.
- `run` prints the results directory. Find the attempt's `result.json` there and check that `solve.finalText` is `Answer: A`, `executionStatus` is `completed`, and `scoreStatus` is `valid`. GPQA shuffles the choices, so a score of zero is fine for this check.
- The same attempt directory contains `agent/trajectory.jsonl` and `agent/session.jsonl`.

To check that validation works, set `answer` to a number and rerun `inspect`. It should report an error.

## Next steps

See the [Solver development reference](solver-development.en.md) to call a model, install a runtime, or start a child process.
