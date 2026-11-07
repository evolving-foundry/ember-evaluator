# 开发文档

> [English](./README.en.md) | 中文

本目录面向修改 Evaluator 或编写插件的开发者。安装、运行实验和故障处理见[用户文档](../users/README.zh-CN.md)。

| 目标 | 文档 |
| --- | --- |
| 从独立项目编译外部插件，配置文件/包名加载、SDK 与 Ray 部署并验收 | [接入外部插件](external-plugins.md) |
| 了解八类组件、注册指标、显式加载 patch | [插件开发与加载](plugins.md) |
| 接入数据集：确认官方要求，配置镜像、平台、资源、超时并验收 | [Benchmark 评测要求与验收指南](benchmark-evaluation-requirements.md) |
| 编写插件：实现接口、注册 Profile，处理生命周期并运行回归测试 | [Benchmark 开发指南](benchmarks.md) |
| 抛出结构化错误并保留诊断 | [插件错误处理](diagnostics.md) |
| 检查 Office Ray 多槽位与 AgentX 桥接协议 | [运行时与并发检查](runtime-validation.md) |
| 查看目录职责、依赖规则、执行顺序和资源释放责任 | [源码架构与执行流程](architecture.md) |

新功能的中间设计和实施记录按[文档规范](../AGENTS.md)放入 `docs/design/` 与 `docs/tasks/`；测试 fixture 的用法和受控验证放在本目录，用户指南只描述当前操作、结果和限制。
