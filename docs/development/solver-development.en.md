# Solver Development Reference

> English | [中文](./solver-development.md)

[Add a Solver](add-solver.en.md) walks through your first controlled run. Use this reference when adding model calls, runtime requirements, or processes.

## Choose the Solver methods

Implement `requirements()` and `solve(input, session, context)` from the [Solver contract](../../src/core/contracts/solver.ts). Declare required runtimes in `requirements()`. Return `finalText` and token usage from `solve()`. Use `null` for unknown usage. Use `0` when the Solver made no model calls.

To bind a process or initialize state at attempt startup, implement `prepare(session, context)` and return a `PreparedSolver`. Evaluator invokes its `solve()`, and `dispose(signal)` releases its resources. Pass `context.signal` to operations and cover normal completion, failure, and cancellation. Attach resources shared across attempts to the Cordis plugin lifecycle.

Implement `provenance()` when resume requires a stable model or runtime identity. Return identifiers that can be saved without credentials, temporary directories, or host paths.

## Bind services and save evidence

Use `bindSolverService(runtime)` for the model and credentials selected by `benchmark.solver.service`. Pass `context.signal` to model requests. See [`choice-logprobs`](../../src/plugins/solvers/choice-logprobs.ts) and its [registration factory](../../src/plugins/solvers/index.ts). The Solver consumes public task input and the execution environment. The Benchmark or Verifier handles scoring. See [Solver in a standalone project](external-plugins.en.md#solver-in-a-standalone-project) for compiling and loading an external Solver.

Write `trajectory.jsonl` and `session.jsonl` under `context.paths.agent`. Each trajectory event carries the attempt `key` and a contiguous `seq` starting at 1. Write one final `end` event on completion. Check the files against the [minimal example](add-solver.en.md#minimal-example). Redact errors, model requests, and tool output before saving them.

## Declare runtime installation

When Solver `runtimeInstallation()` returns `RuntimeInstallation`, it may set `cacheName`, e.g. agentx-1.0.7-py3.12. Local paths are `<root>/<cacheName>/<12-char-hash>`; the default name is runtime. Names accept 1–48 lowercase ASCII letters/digits/dots/hyphens, with alphanumeric ends, excluding Windows reserved devices. Names affect local paths only; the digest still covers id/platform/files/commands, leaving Docker identity unchanged. Install directly in final directories so commands may persist absolute {root}. See [runtime caches](../users/installation.md#local-runtime-cache-and-windows-path-length).

Use `runtimeInstallation()` to describe files, commands, and probes. Let the Environment perform installation on the target. Keep installation out of registration and configuration validation.

## Verify the implementation

- Use `inspect` to check the registered name, configuration types, unknown fields, and service binding.
- Run a controlled experiment and check `finalText`, usage, scoring, and artifacts. For a Solver that calls a model or starts tools, cover exit and cleanup after failure, timeout, and cancellation.
- If the implementation declares additional runtimes or requires Docker or Ray, verify installation and execution in the corresponding environment. The local example covers local execution.
