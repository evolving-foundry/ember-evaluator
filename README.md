<h1 align="center">
  <img src="imgs/ember-evaluator-logo.png" alt="Ember Evaluator" width="520">
</h1>

<h3 align="center">Many ways to evaluate. One framework to bring them together.</h3>

<p align="center">
  Bring benchmarks, agent evaluations, and performance testing into one workflow — across coding, terminal, office, web, and more.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.x">
  <img src="https://img.shields.io/badge/pnpm-11.22.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 11.22.0">
  <img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="License: Apache-2.0">
</p>

<p align="center">
  English | <a href="./README.zh-CN.md">中文</a>
</p>

<p align="center">
  <a href="docs/users/quick-start.md">Quick Start</a> ·
  <a href="docs/users/README.md">Documentation</a> ·
  <a href="playbook/README.md">Playbooks</a> ·
  <a href="docs/development/plugins.en.md">Plugins</a>
</p>

## ℹ️ Introduction

Ember Evaluator configures models, agents, benchmarks, and execution environments in one YAML file. It executes tasks, verifies answers, saves results, and generates reports so you can compare models and agents under the same experimental conditions.

It supports math and knowledge questions, code changes, terminal operations, office, web, and security tasks. AgentX can also replay traces to measure model service throughput and latency.

![Evaluator architecture from YAML configuration through execution, verification, result storage, and reporting](imgs/01-framework-project-overview-v2.png.png)

Models and agents solve tasks, benchmarks verify them, and stores save results and evidence. See [Source architecture and execution flow](docs/development/architecture.en.md) for module responsibilities, dependencies, and resource ownership.

## ⚙️ Features

- **Multiple evaluation workloads**: GSM8K, MMLU, HumanEval, Terminal-Bench, SWE-bench, WorkBuddy, [OfficeQA Pro V2](docs/users/benchmarks/officeqa-pro-v2.md) (parsed JSON by default, with original PDF support), and custom Harbor tasks. See [supported benchmarks](docs/users/README.md#supported-benchmarks).
- **Multiple agents and model services**: Built-in SimpleAgent and AgentBundle with support for the dsh, dify, pi, deepagents, hermes, and jiuwenswarm harnesses. See [solvers and model services](docs/users/solvers.md).
- **Local, container, and distributed execution**: Run tasks in local or Docker environments, schedule them locally or through Ray, and control concurrency and environment preparation. See [execution modes](docs/users/usage.md#local-docker-and-ray) and [concurrency](docs/users/concurrency.md).
- **Network configuration**: Configure proxies, data download URLs, Docker registry mirrors, and package sources. See the [network configuration guide](docs/users/network.md).
- **Evidence and resume**: Save configuration, source versions, trajectories, verification logs, and artifacts. Resume unfinished tasks after interruption. See [resume and result files](docs/users/usage.md#resume-and-rebuild-reports).
- **Metrics and offline reports**: Compute scores, accuracy, duration, and token usage, and rebuild Markdown reports from saved results. See [reading results](docs/users/usage.md#read-results) and [scoring](docs/users/reference/scoring.md).
- **Model service performance**: Measure throughput, TTFT, ITL, and request latency with AgentX, optionally collecting vLLM and Ascend NPU metrics. See [AgentX](docs/users/benchmarks/agentx.md).
- **Plugins**: Replace or add any of eight component types, including Benchmark, Verifier, Solver, and Environment. See [plugin development and loading](docs/development/plugins.en.md).
- **Node.js SDK**: Execute evaluations with `Evaluator.run()`, including progress, cancellation, resume, and Ray Jobs. See the [SDK guide](docs/users/sdk.md).

## 📦 Installation and Deployment

### Agent Instruction

Copy this instruction into your coding agent.

```text
Install the Ember Evaluator CLI and its ember-evaluator skill from https://github.com/evolving-foundry/ember-evaluator.
Follow the Manual Installation steps in the README to install both. Install the skill for this agent in the target project.
Run ember-evaluator --help and confirm that this agent can discover and read the skill. Stop after verifying installation.
```

### Manual Installation

#### 1. Install the CLI

Requirements:

1. **Node.js** >= 24.22.1 (24.x).
2. **pnpm** >= 11 < 13. If missing, run `npm install --global pnpm` first.
3. **Git** and read access to the private AgentBundle repository.

Clone the repository, then build and install from its root.

```bash
git clone https://github.com/evolving-foundry/ember-evaluator.git
cd ember-evaluator
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .
ember-evaluator --help
```

The help output confirms installation. See the [installation guide](docs/users/installation.md) for details, or use the [management container](docs/users/deployment/container-toolbox.md) on Linux servers.

#### 2. Install the skill

Run this from the project where you want to use the skill, then select your coding agent.

```bash
npx skills add evolving-foundry/ember-evaluator --skill ember-evaluator
```

## 🚀 Quick Start

Run two GSM8K math questions locally with SimpleAgent; Docker is not required. Replace the model name, API URL, and key with your own values, then run from the repository root in Bash:

```bash
export MODEL_NAME="your-model-id"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"

ember-evaluator inspect playbook/gsm8k/gsm8k-quick-start.yaml
ember-evaluator run playbook/gsm8k/gsm8k-quick-start.yaml
```

Use `inspect` to validate the configuration file and review the expanded experiment and network settings before executing `run`.

The model service must support OpenAI Chat Completions and tool calling. When the run finishes, open `report.md` in the result directory shown in the logs. See the [two-question quick start](docs/users/quick-start.md) for PowerShell commands and more details.

| Goal | Benchmark / scenario | Environment | Additional requirements | Quick start |
| --- | --- | --- | --- | --- |
| Check model execution and reporting | GSM8K, two questions | local | Model API with tool calling | [Two-question quick start](docs/users/quick-start.md) |
| Evaluate terminal operations | Terminal-Bench 4.0 | Docker | amd64 images; QEMU/binfmt on ARM64 | [Terminal-Bench 4.0](docs/users/quick-start/terminalbench.md) |
| Standard model service performance evaluation | AgentX standard | local, optionally in the management container | Python 3.11–3.13, venv, tokenizer, streaming model service with long context; management image includes Python | [AgentX performance](docs/users/quick-start/agentx.md) |

See [Playbook examples](playbook/README.md) for other benchmarks and combinations, and the [user documentation](docs/users/README.md) for resume, reports, and daily operations.

## 🔥 Warm Images Before Evaluation

For Docker workloads, use `warmup` to download or build images and install dependencies before evaluation. The following commands use the same experiment YAML to check the environment, prepare images, and start evaluation:

```bash
ember-evaluator doctor playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml
```

Resolve failed `doctor` checks before running `warmup`. Warmup prepares solve, verification, and service images for the selected tasks, plus Evaluator runtimes and Solver dependencies. It makes no model calls, executes no tasks, and creates no evaluation reports.

Warmup does not require a model API key, but model names, endpoints, and other configuration must be valid. Add model credentials for evaluation and keep task versions, task selection, platform, plugin configuration, and Docker daemon unchanged to reuse cached images.

Local Docker, Ray Client, and Ray Jobs support warmup; Ray prepares images on the execution nodes. See the [image warmup guide](docs/users/usage.md#warm-images-without-evaluation) for options and prerequisites.

### 📥 Download Evaluation Images from ModelScope

**Ember Evaluator can download task image archives from ModelScope and load them into Docker automatically.** Once an archive source is configured, `warmup` and `run` select images by task, platform, and solve/verify phase. Hugging Face image archives are also supported.

> **Official image repository: [evolving-foundry/ember-evaluator](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator)**
>
> Maintained by the Ember Evaluator team, this repository hosts official task image archives for selected benchmarks. Check its file tree for available tasks and platforms.

Use the bundled network file from the repository root. The experiment YAML selects the benchmark, model, and tasks; the YAML after `--network` selects image download sources:

```bash
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
```

Prepare Docker, model settings, and task selection using the [Terminal-Bench quick start](docs/users/quick-start/terminalbench.md). The example selects all tasks; only published tasks and platforms are available, and other downloads retain their defaults. See [how to use --network](docs/users/network.md#1-choose-a-network-file) to select mirrors, combine settings, or set a default file.

## 📖 Guides

Choose a guide for your task:

- **Configure experiments**: [YAML, profiles, and environment variables](docs/users/config.md); [solvers, AgentBundle, and model services](docs/users/solvers.md).
- **Run workloads**: [Benchmark guides](docs/users/benchmarks/README.md); [experiment configurations](playbook/README.md).
- **Manage evaluation runs**: [Task selection, resume, and reports](docs/users/usage.md); [image warmup](docs/users/usage.md#warm-images-without-evaluation); [image cleanup](docs/users/usage.md#delete-evaluation-images); [concurrency, preparation pipelines, and timeouts](docs/users/concurrency.md).
- **Measure service performance**: [AgentX concurrency sweeps, trace replay, and metrics](docs/users/benchmarks/agentx.md).
- **Extend the project**: [Plugin development and loading](docs/development/plugins.en.md); [benchmark requirements and acceptance](docs/development/benchmark-evaluation-requirements.en.md) for dataset integration; [benchmark development](docs/development/benchmarks.en.md) for plugins.
- **Troubleshoot**: [Downloads, logs, and truncated model output](docs/users/faq/README.md); [error codes](docs/users/reference/errors.md); [retrying network failures](docs/users/network-retry.md).

See the [user documentation index](docs/users/README.md) for all guides, benchmarks, and execution limitations.

## 🧪 Supported Benchmarks

Benchmarks fall into three categories by evaluation purpose:

| Category | Supported benchmarks | What is measured and where to start |
| --- | --- | --- |
| Model + agent harness capability evaluation | GSM8K, MATH-500, MGSM, MMLU, MMLU-Pro, GPQA, DROP, TriviaQA, SimpleQA, HealthBench, HumanEval, DeepSWE, SWE-bench Verified, Terminal-Bench, WorkBuddy, OfficeQA Pro V2, and custom Harbor task packages | Math, knowledge questions, code generation and changes, terminal, office, web, and security tasks, with accuracy or scores computed under each benchmark's rules. See [benchmarks and requirements](docs/users/README.md#supported-benchmarks) and [Playbook configurations](playbook/README.md). |
| Inference engine performance evaluation (AgentX) | AgentX (`agentx`) | Replay agent traces to measure throughput, TTFT, ITL, and request latency, optionally collecting vLLM and Ascend NPU metrics. See the [AgentX guide](docs/users/benchmarks/agentx.md). |
| Operator performance evaluation (kernel) | kernel (`kernel`) | Verify existing candidate kernels on Ascend NPU, measure reference and candidate execution times and speedup, and optionally collect detailed hardware performance metrics. Runs locally and serially without model calls. See the [kernel guide](docs/users/benchmarks/kernel-npu.md) and [example configuration](playbook/kernel/existing.yaml). |

## 📊 Evaluation Results

`tbd` indicates a pending evaluation. Compare document inputs, task ranges, and scoring conditions along with the scores.

**Model** · DeepSeek V4.1 Flash 1017

| Benchmark | Agent Harness | Result |
| --- | --- | --- |
| GSM8K | SimpleAgent | 92.34% (1,218 / 1,319) |
| MMLU | choice-logprobs | 88.83% (12,474 / 14,042) |
| WorkBuddy | SimpleAgent | Office 0.8502 · Code 0.9009 · Web 0.7957 |
| Terminal-Bench 4.0 | SimpleAgent | `tbd` |
| SWE-bench Verified | SimpleAgent | `tbd` |
| OfficeQA Pro V2 | SimpleAgent | 56.67% (51 / 90) |

## 🙏 Acknowledgments

Thanks to the Cordis maintainers and contributors. Ember Evaluator uses Cordis to register plugins and manage component lifecycles. [Cordis project](https://github.com/cordiverse/cordis)

Thanks to the Harbor maintainers and contributors. Ember Evaluator supports Harbor task packages and follows Harbor protocols for task execution and verification. [Harbor project](https://github.com/harbor-framework/harbor)

## 🔗 Related Projects

- [Ember RSI](https://github.com/evolving-foundry/ember-rsi): Tools for iterative optimization through measured experiments.
- [AgentBundle](https://github.com/evolving-foundry/agentbundle): A unified CLI and SDK for validating, installing, and managing agent bundles across runtimes.
