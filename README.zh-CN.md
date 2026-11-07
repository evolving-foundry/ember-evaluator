<h1 align="center">
  <img src="imgs/ember-evaluator-logo.png" alt="Ember Evaluator" width="520">
</h1>

<h3 align="center">多种评测方法，一个框架统一承载。</h3>

<p align="center">
  插件化评测框架，覆盖 Agent Harness、推理引擎和算子，并将扩展到更多评测领域。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.x">
  <img src="https://img.shields.io/badge/pnpm-11.22.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 11.22.0">
  <img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="License: Apache-2.0">
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<p align="center">
  <a href="docs/users/quick-start.zh-CN.md">快速开始</a> ·
  <a href="docs/users/README.zh-CN.md">使用文档</a> ·
  <a href="playbook/README.md">实验配置</a> ·
  <a href="docs/development/plugins.md">插件开发</a>
</p>

## ℹ️ 简介

Ember Evaluator 用 YAML 选择任务和组件，用 `--patch` 加载自定义插件。评测支持自定义网络配置、网络故障自动重试、中断续跑和按题定位错误。

支持多种评测场景，包括 Agent Harness 的终端、编程和办公任务评测，推理引擎性能测试，以及算子正确性和性能测试。

![Evaluator 从 YAML 配置到任务执行、验证、结果保存和报告生成的整体架构](imgs/01-framework-project-overview-v2.png.png)

[源码架构与执行流程](docs/development/architecture.md)

## ⚙️ 功能介绍

- **多种评测任务**。用 Terminal-Bench、SWE-bench Verified、WorkBuddy 或自有 Harbor 任务，让 Agent 执行终端、代码和办公任务。OfficeQA Pro V2 支持解析后的 JSON 和原始 PDF。 [支持的 Benchmark](docs/users/README.zh-CN.md#现在能测哪些-benchmark) · [OfficeQA Pro V2](docs/users/benchmarks/officeqa-pro-v2.zh-CN.md)
- **本机、容器与分布式执行**。在本机或 Docker 中执行，按需配置并发。使用 Ray 时，每个节点只预热分给自己的题目。 [执行方式](docs/users/usage.zh-CN.md#本地docker-与-ray) · [并发与预热](docs/users/concurrency.zh-CN.md)
- **证据保存与任务续跑**。按题记录失败阶段、错误码、执行轨迹和验证日志。用 `--resume` 继续原评测，用 `retry` 补测符合条件的网络失败题。 [续跑](docs/users/usage.zh-CN.md#续跑与重建报告) · [错误定位](docs/users/reference/errors.zh-CN.md) · [网络补测](docs/users/network-retry.zh-CN.md)
- **模型服务性能测量**。AgentX 回放请求轨迹，测吞吐、首 token 延迟和请求耗时，可采集 vLLM 与 Ascend NPU 指标。 [AgentX 指南](docs/users/benchmarks/agentx.zh-CN.md)
- **多种 Agent 与模型服务**。可用内置 SimpleAgent，或通过 AgentBundle 接入 DSH、Dify、Pi、DeepAgents、Hermes 和 JiuwenSwarm。 [Solver 与模型服务](docs/users/solvers.zh-CN.md)
- **指标与离线报告**。从已保存结果统计得分、正确率、耗时和 token 用量，生成 Markdown 报告。 [结果阅读](docs/users/usage.zh-CN.md#如何读结果) · [评分口径](docs/users/reference/scoring.zh-CN.md)
- **网络配置**。用 `--network` 为实验选择适合运行环境的配置。 [网络配置](docs/users/network.zh-CN.md)
- **插件扩展**。用 `--patch` 加载自定义 Benchmark、Solver 或 Verifier 等组件。 [插件开发](docs/development/README.md#第一次新增组件)
- **Node.js SDK**。用 `Evaluator.run()` 发起评测，支持进度、取消、续跑和 Ray Jobs。 [SDK 指南](docs/users/sdk.zh-CN.md)

## 📦 安装部署

### Agent Instruction

将以下指令交给编程 Agent。

```text
请从 https://github.com/evolving-foundry/ember-evaluator 安装 Ember Evaluator CLI 和配套的 ember-evaluator skill。
按照 README 的 Manual Installation 步骤安装 CLI，并在目标项目中为当前 Agent 安装 skill。
运行 ember-evaluator --help，并确认当前 Agent 能发现和读取该 skill。验证安装后结束任务。
```

### Manual Installation

#### 1. 安装 CLI

准备 Node.js 24.x（至少 24.22.1）、pnpm 11 或 12，以及能读取私有 AgentBundle 仓库的 Git。缺少 pnpm 时，先执行 `npm install --global pnpm`。

```bash
git clone https://github.com/evolving-foundry/ember-evaluator.git
cd ember-evaluator
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .
ember-evaluator --help
```

看到帮助信息即安装成功。 [安装指南](docs/users/installation.zh-CN.md) · [Linux 管理容器](docs/users/deployment/container-toolbox.zh-CN.md)

#### 2. 安装 skill

在要使用 skill 的项目目录执行，并选择对应的编程 Agent。

```bash
npx skills add evolving-foundry/ember-evaluator --skill ember-evaluator
```

## 🚀 快速入门

在仓库根目录用 Bash 运行两道 GSM8K 题。示例使用本机的 SimpleAgent，将以下模型设置换成支持 OpenAI Chat Completions 和工具调用的服务。

```bash
export MODEL_NAME="your-model-id"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"

ember-evaluator inspect playbook/gsm8k/gsm8k-quick-start.yaml
ember-evaluator run playbook/gsm8k/gsm8k-quick-start.yaml
```

`inspect` 检查配置，`run` 开始评测。结束后打开终端所示结果目录里的 `report.md`。 [完整步骤和 PowerShell 用法](docs/users/quick-start.zh-CN.md)

| 评测目标 | Benchmark / 场景 | 执行环境 | 额外条件 | 快速入门 |
| --- | --- | --- | --- | --- |
| 跑通模型与报告链路 | GSM8K，两道题 | local | 支持工具调用的模型 API | [两题快速上手](docs/users/quick-start.zh-CN.md) |
| 评测终端操作能力 | Terminal-Bench 4.0 | Docker | amd64 镜像；ARM64 需 QEMU/binfmt | [Terminal-Bench 4.0 入门](docs/users/quick-start/terminalbench.zh-CN.md) |
| 模型服务标准性能测评 | AgentX standard | local，可选管理容器 | Python 3.11–3.13、venv、tokenizer、长上下文流式模型服务；管理镜像已提供 Python | [AgentX 性能入门](docs/users/quick-start/agentx.zh-CN.md) |

更多配置见 [Playbook](playbook/README.md)。

## 🔥 评测前预热镜像

用同一份 YAML 检查环境、预热镜像，再开始评测。先处理 `doctor` 报出的失败项。

```bash
ember-evaluator doctor playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml
```

`warmup` 提前准备解题、验证和侧车镜像，以及 Solver 运行依赖。模型调用和评分留到 `run`，预热阶段可省略模型 API key。

本机 Docker、Ray Client 和 Ray Jobs 均可预热。Ray 在实际执行节点准备镜像。保持实验配置和执行环境一致，正式运行可复用缓存。 [预热指南](docs/users/usage.zh-CN.md#只预热镜像不开始测评)

### 📥 从 ModelScope 下载评测镜像

`warmup` 和 `run` 可按题目、平台和阶段下载 ModelScope 归档并加载到 Docker，也支持 Hugging Face 归档。 [官方 ModelScope 镜像仓库](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator)

以下命令用 `--network` 指定镜像来源。

```bash
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
```

示例默认选全部题目，归档下载范围以已发布的题目和平台为准。 [Terminal-Bench 入门](docs/users/quick-start/terminalbench.zh-CN.md) · [镜像来源配置](docs/users/network.zh-CN.md#1-先选一份网络配置)

## 📖 使用指南

- **配置实验** · [YAML 和 Profile](docs/users/config.zh-CN.md) · [Solver 和模型服务](docs/users/solvers.zh-CN.md)
- **运行不同任务** · [Benchmark 指南](docs/users/benchmarks/README.zh-CN.md) · [可运行配置](playbook/README.md)
- **管理评测过程** · [选题、续跑与报告](docs/users/usage.zh-CN.md) · [并发](docs/users/concurrency.zh-CN.md) · [镜像清理](docs/users/usage.zh-CN.md#删除评测镜像)
- **测量服务性能** · [AgentX 并发扫描和轨迹回放](docs/users/benchmarks/agentx.zh-CN.md)
- **扩展项目** · [新增 Solver](docs/development/add-solver.md) · [新增内置组件](docs/development/add-built-in-plugin.md) · [新增外部插件](docs/development/add-external-plugin.md) · [Benchmark 开发](docs/development/benchmarks.md) · [数据集验收](docs/development/benchmark-evaluation-requirements.md)
- **排查问题** · [FAQ](docs/users/faq/README.zh-CN.md) · [错误码](docs/users/reference/errors.zh-CN.md) · [网络补测](docs/users/network-retry.zh-CN.md)

## 🧪 支持的 Benchmark

| 类别 | 支持的 Benchmark | 评测内容与使用说明 |
| --- | --- | --- |
| 模型 + Agent Harness 能力测评 | GSM8K、MATH-500、MGSM、MMLU、MMLU-Pro、GPQA、DROP、TriviaQA、SimpleQA、HealthBench、HumanEval、DeepSWE、SWE-bench Verified、Terminal-Bench、WorkBuddy、OfficeQA Pro V2，以及自有 Harbor 任务包 | 按各题库规则评测问答、代码、终端、办公、网页和安全任务。 [题库与运行条件](docs/users/README.zh-CN.md#现在能测哪些-benchmark) |
| 推理引擎性能测评（AgentX） | AgentX（`agentx`） | 回放 Agent 请求轨迹，测吞吐、首 token 延迟、token 间隔和请求耗时。 [AgentX 指南](docs/users/benchmarks/agentx.zh-CN.md) |
| 算子性能测评（kernel） | kernel（`kernel`） | 在本机 Ascend NPU 上串行验证候选算子，比较耗时与加速比，可采集硬件指标。 [算子指南](docs/users/benchmarks/kernel-npu.zh-CN.md) · [配置示例](playbook/kernel/existing.yaml) |

## 📊 评测结果

模型为 **DeepSeek V4.1 Flash 1017**。`tbd` 表示待测。分数按各题库自己的规则计算。

| Benchmark | Agent Harness | 结果 |
| --- | --- | --- |
| GSM8K | SimpleAgent | 92.34% (1,218 / 1,319) |
| MMLU | choice-logprobs | 88.83% (12,474 / 14,042) |
| WorkBuddy | SimpleAgent | Office 0.8502 · Code 0.9009 · Web 0.7957 |
| Terminal-Bench 4.0 | SimpleAgent | `tbd` |
| SWE-bench Verified | SimpleAgent | `tbd` |
| OfficeQA Pro V2 | SimpleAgent | 56.67% (51 / 90) |

## 🙏 致谢

感谢 Cordis 的维护者和贡献者。Ember Evaluator 使用 Cordis 注册插件并管理组件生命周期。[Cordis 项目](https://github.com/cordiverse/cordis)

感谢 Harbor 的维护者和贡献者。Ember Evaluator 支持 Harbor 任务包，并遵循 Harbor 协议执行和验证任务。[Harbor 项目](https://github.com/harbor-framework/harbor)

## 🔗 相关项目

- [Ember RSI](https://github.com/evolving-foundry/ember-rsi)：通过可衡量的实验开展迭代优化的工具。
- [AgentBundle](https://github.com/evolving-foundry/agentbundle)：跨运行时验证、安装和管理 Agent Bundle 的统一 CLI 与 SDK。

