# Terminal-Bench 评测

> [English](./terminalbench.md) | 中文

使用 `benchmark.name: terminalbench` 选择内置 Profile。默认版本为 `2.0`；选择 `version: "4.0"` 或 `"4.0.0"` 使用 4.0 任务包。

[Benchmark 目录](README.zh-CN.md) · [4.0 快速入门](../quick-start/terminalbench.zh-CN.md)

## 选择版本与运行配置

| 版本 | 配置与条件 |
| --- | --- |
| 2.0 | [SimpleAgent 示例](../../../playbook/terminalbench/terminalbench-simpleagent.yaml)，使用 Docker 和任务内验证器 |
| 4.0 | [全量示例](../../../playbook/terminalbench/terminalbench-4.0.yaml)，官方 v4.0.0 预构建归档、固定 SHA-256、amd64 任务镜像 |

4.0 来源包含对应提交的 66 道任务；这是来源范围，不表示所有任务都已执行或通过。首次运行先按快速入门限制两题。默认 Agent 时限为每题 28800 秒，外层整题预算为 86400 秒；完整默认值见[Profile](../../../src/plugins/benchmarks/agent-harness/profiles/terminalbench.yaml)。

## 环境与支持条件

任务声明了镜像时优先使用固定镜像；没有镜像声明时才按 Dockerfile 构建。Compose 服务组按任务声明启动，GPU 等尚未实现的能力记录为 unsupported；资源不足记录 `ENV_RESOURCE_REQUIREMENTS_UNMET`。不要通过删除来源中的失败任务来解释为完整题集成绩。

ARM64 节点运行 amd64 镜像需要 QEMU/binfmt，见[Docker 平台规则](../deployment/docker-platform.zh-CN.md)。求解与验证的镜像选择、网络和产物交付见[Harbor 指南](harbor.zh-CN.md#执行与验证边界)，预算与并发见[环境准备](../concurrency.zh-CN.md)。

结果保存在实验输出目录，按任务内验证器产生的奖励评分。切换版本或数据来源后开始新 run，不能绕过来源锁续跑旧实验。
