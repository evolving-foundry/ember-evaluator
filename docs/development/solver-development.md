# Solver 开发参考

> [English](./solver-development.en.md) | 中文

从[新增 Solver](add-solver.md)运行第一份受控实验。本文说明实现时需要选择哪些接口，以及如何验证带模型、运行时和进程的 Solver。

## 选择 Solver 接口

实现 [Solver](../../src/core/contracts/solver.ts) 的 `requirements()` 和 `solve(input, session, context)`。`requirements()` 声明环境需要提供的运行时。`solve()` 返回 `finalText` 和 token 用量。无法获知的用量填 `null`，确定没有调用模型时可以填 `0`。

需要在 attempt 启动时绑定进程或准备状态时，实现 `prepare(session, context)` 并返回 `PreparedSolver`。Evaluator 使用它的 `solve()` 执行，资源由该对象的 `dispose(signal)` 释放。传递 `context.signal`，并覆盖正常返回、失败和取消。跨 attempt 持有的资源由插件工厂通过 Cordis 生命周期释放。

要固定可续跑的模型或运行时来源时，可实现 `provenance()`。返回稳定、可持久化的标识，避免包含认证、临时目录和宿主路径。

## 绑定模型与保存证据

调用模型时，用 `bindSolverService(runtime)` 读取 `benchmark.solver.service` 选中的模型和认证，向模型请求传递 `context.signal`。可参考 [`choice-logprobs`](../../src/plugins/solvers/choice-logprobs.ts) 和它的[注册工厂](../../src/plugins/solvers/index.ts)。Solver 使用 `PublicTask` 和执行环境，评分由 Benchmark 或 Verifier 完成。外置 Solver 的编译和加载见[独立项目中的 Solver](external-plugins.md#独立项目中的-solver)。

Solver 在 `context.paths.agent` 下保存 `trajectory.jsonl` 和 `session.jsonl`。轨迹事件包含当前 attempt 的 `key`、从 1 开始连续递增的 `seq`，完成时写一个末尾 `end` 事件。参照[最小示例](add-solver.md#最小示例)检查文件内容。记录错误、模型请求和工具输出时先脱敏。

## 声明安装步骤

Solver 的 `runtimeInstallation()` 返回 `RuntimeInstallation` 时，可以设置 `cacheName`，例如 `agentx-1.0.7-py3.12`。本机托管目录为 `<缓存根目录>/<cacheName>/<12 位内容哈希>`；未设置时名称为 `runtime`。名称为 1～48 个小写 ASCII 字母、数字、点或连字符，首尾必须是字母或数字，不接受 Windows 设备保留名称。名称仅用于本机缓存目录，不参与内容摘要；完整摘要仍根据 `id`、平台、文件及命令计算，Docker 镜像身份不受名称影响。安装直接在最终目录执行，因此命令可以保存 `{root}` 的绝对路径。缓存位置及清理方法见[安装指南](../users/installation.zh-CN.md#本机运行时缓存与-windows-路径长度)。

`runtimeInstallation()` 返回安装所需文件、命令和探针。需要落在目标环境内的安装交给 Environment，避免在组件注册或配置校验时启动安装。

## 验证

- 用 `inspect` 检查注册名、配置类型、未知字段和服务绑定。
- 跑一份受控实验，检查返回的 `finalText`、用量、评分和产物。若实现会调用模型或工具，分别覆盖失败、超时和取消后的退出与清理。
- 声明额外运行时或需要 Docker、Ray 时，在对应环境验证安装与执行。受控本地样例只覆盖本地路径。
