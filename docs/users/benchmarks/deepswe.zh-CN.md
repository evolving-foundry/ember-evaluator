# DeepSWE 评测

> [English](./deepswe.md) | 中文

DeepSWE 用代码仓库任务评测 Agent 修改代码和通过测试的能力。内置 Profile 为 `deepswe`，默认版本 `1.1`，来源固定到 Git 提交并按任务锁定内容。

[用户文档](../README.zh-CN.md) · [Benchmark 目录](README.zh-CN.md) · [Harbor 执行规则](harbor.zh-CN.md)

## 配置与运行

先完成[安装](../installation.zh-CN.md)，准备模型变量、Docker 和任务所需镜像。模型及 Agent 需要能调用工具并修改代码文件。

| 运行方式 | 配置 |
| --- | --- |
| 最简配置 | [deepswe.yaml](../../../playbook/deepswe/deepswe.yaml) |
| 单机 SimpleAgent | [deepswe-simpleagent.yaml](../../../playbook/deepswe/deepswe-simpleagent.yaml) |
| Ray + AgentBundle | [deepswe-agentbundle-ray.yaml](../../../playbook/deepswe/deepswe-agentbundle-ray.yaml) |

在 Evaluator 仓库根目录检查并运行：

```bash
ember-evaluator doctor playbook/deepswe/deepswe-simpleagent.yaml
ember-evaluator run playbook/deepswe/deepswe-simpleagent.yaml
```

首次运行先在所选 YAML 中限制 `run.maxTasks`，确认镜像、模型和验证都可用后再新建全量实验。默认题目范围、来源和版本见[内置 Profile](../../../src/plugins/benchmarks/agent-harness/profiles/deepswe.yaml)；选题与续跑见[日常操作](../usage.zh-CN.md)。

## 环境与验证

求解阶段使用 `task.toml` 指定的预构建任务镜像，独立验证按任务声明构建 `tests/Dockerfile`。任务 TOML 未声明架构，而所用镜像只有 amd64 时，在实验 YAML 中设置 `environment.platform: linux/amd64`。ARM64 节点还需可用的 QEMU/binfmt；平台选择与检测见[Docker 平台](../deployment/docker-platform.zh-CN.md)。

任务 CPU、内存和验证时限来自任务声明，实验整题预算与环境准备预算分别计时，见[并发与环境准备](../concurrency.zh-CN.md)。评分使用任务原生奖励，`f2p`、`p2p`、`partial` 维度由保存结果汇总；不要更改官方测试来消除任务失败。

## 常见问题

- Go、esbuild 崩溃或冷构建过慢：见 [Docker FAQ](../faq/docker.zh-CN.md)。
- 已下载数据仍报 GitHub 403：见[数据缓存 FAQ](../faq/downloads.zh-CN.md#已有缓存为什么还会访问数据源)。
- CPU 可见数量、证据权限或清理失败：见 [Docker FAQ](../faq/docker.zh-CN.md)。
