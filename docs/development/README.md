# 开发文档

> [English](./README.en.md) | 中文

本目录面向修改 Evaluator 或编写插件的开发者。安装、运行实验和故障处理见[用户文档](../users/README.zh-CN.md)。

## 第一次新增组件

| 你想做什么 | 从这里开始 | 需要深入时 |
| --- | --- | --- |
| 写一个负责作答的 Solver | [新增 Solver](add-solver.md) | [模型、运行时和资源清理](solver-development.md) |
| 给 Evaluator 源码加一个组件，例如指标 | [新增内置组件](add-built-in-plugin.md) | [组件接口和注册位置](plugins.md#新增内置组件) |
| 把自己写的文件用 `--patch` 加载进来 | [新增外部插件](add-external-plugin.md) | [TypeScript、包名加载和 Ray](external-plugins.md) |

## 其他开发文档

| 目标 | 文档 |
| --- | --- |
| 接入数据集：确认官方要求，配置镜像、平台、资源、超时并验收 | [Benchmark 评测要求与验收指南](benchmark-evaluation-requirements.md) |
| 编写插件：实现接口、注册 Profile，处理生命周期并运行回归测试 | [Benchmark 开发指南](benchmarks.md) |
| 抛出结构化错误并保留诊断 | [插件错误处理](diagnostics.md) |
| 检查 Office Ray 多槽位与 AgentX 桥接协议 | [运行时与并发检查](runtime-validation.md) |
| 查看目录职责、依赖规则、执行顺序和资源释放责任 | [源码架构与执行流程](architecture.md) |

新功能的中间设计和实施记录按[文档规范](../AGENTS.md)放入 `docs/design/` 与 `docs/tasks/`；测试 fixture 的用法和受控验证放在本目录，用户指南只描述当前操作、结果和限制。
