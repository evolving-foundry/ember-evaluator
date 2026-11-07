<h1 align="center">
  <img src="imgs/ember-evaluator-logo.png" alt="Ember Evaluator" width="520">
</h1>

<h3 align="center">Many ways to evaluate. One framework to bring them together.</h3>

<p align="center">
  A plugin-based framework for evaluating agent harnesses, inference engines, and kernels, with more areas to come.
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

Ember Evaluator uses YAML to select tasks and components and `--patch` to load custom plugins. Evaluations support custom network settings, automatic network retries, run resumption, and per-task failure diagnostics.

Supported scenarios include evaluating agent harnesses on terminal, coding, and office tasks, benchmarking inference engine performance, and testing kernel correctness and performance.

![Evaluator architecture from YAML configuration through execution, verification, result storage, and reporting](imgs/01-framework-project-overview-v2.png.png)

[Source architecture and execution flow](docs/development/architecture.en.md)

## ⚙️ Features

- **Multiple evaluation workloads.** Give agents terminal, coding, and office tasks with Terminal-Bench, SWE-bench Verified, WorkBuddy, or your own Harbor tasks. OfficeQA Pro V2 accepts parsed JSON and original PDFs. [Supported benchmarks](docs/users/README.md#supported-benchmarks) · [OfficeQA Pro V2](docs/users/benchmarks/officeqa-pro-v2.md)
- **Local, container, and distributed execution.** Run locally or in Docker with configurable concurrency. Each Ray worker warms up only its assigned tasks. [Execution modes](docs/users/usage.md#local-docker-and-ray) · [Concurrency and warmup](docs/users/concurrency.md)
- **Evidence and resume.** Per-task results record the failed stage, error codes, traces, and verification logs. Use `--resume` to continue a run and `retry` for eligible network failures. [Resume](docs/users/usage.md#resume-and-rebuild-reports) · [Error diagnostics](docs/users/reference/errors.md) · [Network retries](docs/users/network-retry.md)
- **Model service performance.** AgentX replays requests to measure throughput, time to first token, and latency, with optional vLLM and Ascend NPU metrics. [AgentX guide](docs/users/benchmarks/agentx.md)
- **Multiple agents and model services.** Use SimpleAgent, or run DSH, Dify, Pi, DeepAgents, Hermes, or JiuwenSwarm through AgentBundle. [Solvers and model services](docs/users/solvers.md)
- **Metrics and offline reports.** Use saved results to report scores, accuracy, elapsed time, and token usage. [Read results](docs/users/usage.md#read-results) · [Scoring](docs/users/reference/scoring.md)
- **Network configuration.** Use `--network` to select settings for your execution environment. [Network configuration](docs/users/network.md)
- **Plugins.** Use `--patch` to add a benchmark, solver, verifier, or other component. [Plugin development](docs/development/README.en.md#add-your-first-component)
- **Node.js SDK.** `Evaluator.run()` supports progress, cancellation, resume, and Ray Jobs. [SDK guide](docs/users/sdk.md)

## 📦 Installation and Deployment

### Agent Instruction

Give this instruction to your coding agent.

```text
Install the Ember Evaluator CLI and its ember-evaluator skill from https://github.com/evolving-foundry/ember-evaluator.
Follow the Manual Installation steps in the README to install both. Install the skill for this agent in the target project.
Run ember-evaluator --help and confirm that this agent can discover and read the skill. Stop after verifying installation.
```

### Manual Installation

#### 1. Install the CLI

Use Node.js 24.x (at least 24.22.1), pnpm 11 or 12, and Git with read access to the private AgentBundle repository. If needed, install pnpm with `npm install --global pnpm`.

```bash
git clone https://github.com/evolving-foundry/ember-evaluator.git
cd ember-evaluator
pnpm install --frozen-lockfile
pnpm build
pnpm add -g .
ember-evaluator --help
```

The help output confirms installation. [Installation guide](docs/users/installation.md) · [Linux management container](docs/users/deployment/container-toolbox.md)

#### 2. Install the skill

Run this in the target project and select your coding agent.

```bash
npx skills add evolving-foundry/ember-evaluator --skill ember-evaluator
```

## 🚀 Quick Start

Run two GSM8K questions locally with SimpleAgent. Replace the settings below with an OpenAI Chat Completions service that supports tool calling, then run the commands in Bash from the repository root.

```bash
export MODEL_NAME="your-model-id"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"

ember-evaluator inspect playbook/gsm8k/gsm8k-quick-start.yaml
ember-evaluator run playbook/gsm8k/gsm8k-quick-start.yaml
```

Use `inspect` to check the configuration and `run` to start. Open `report.md` in the results directory printed by the CLI. [Full walkthrough and PowerShell commands](docs/users/quick-start.md)

| Goal | Benchmark / scenario | Environment | Additional requirements | Quick start |
| --- | --- | --- | --- | --- |
| Check model execution and reporting | GSM8K, two questions | local | Model API with tool calling | [Two-question quick start](docs/users/quick-start.md) |
| Evaluate terminal operations | Terminal-Bench 4.0 | Docker | amd64 images; QEMU/binfmt on ARM64 | [Terminal-Bench 4.0](docs/users/quick-start/terminalbench.md) |
| Standard model service performance evaluation | AgentX standard | local, optionally in the management container | Python 3.11–3.13, venv, tokenizer, streaming model service with long context; management image includes Python | [AgentX performance](docs/users/quick-start/agentx.md) |

Find more configurations in the [Playbooks](playbook/README.md).

## 🔥 Warm Images Before Evaluation

Use the same YAML to check the environment, warm the images, and run the evaluation. Address any failed `doctor` checks first.

```bash
ember-evaluator doctor playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml
```

`warmup` prepares the selected tasks’ solve, verification, and sidecar images plus runtime dependencies. Model calls and scoring happen during `run`, so warmup can run without a model API key.

Warmup works with local Docker, Ray Client, and Ray Jobs. Ray prepares images on the execution nodes. Keep the experiment and execution environment the same to reuse cached images. [Warmup guide](docs/users/usage.md#warm-images-without-evaluation)

### 📥 Download Evaluation Images from ModelScope

`warmup` and `run` can load ModelScope archives into Docker by task, platform, and phase. Hugging Face archives are also supported. [Official ModelScope image repository](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator)

Use `--network` to select the image source.

```bash
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
```

The example selects all tasks by default. Archive coverage depends on published tasks and platforms. [Terminal-Bench quick start](docs/users/quick-start/terminalbench.md) · [Configure image sources](docs/users/network.md#1-choose-a-network-file)

## 📖 Guides

- **Configure experiments** · [YAML and profiles](docs/users/config.md) · [Solvers and model services](docs/users/solvers.md)
- **Run workloads** · [Benchmark guides](docs/users/benchmarks/README.md) · [Runnable configurations](playbook/README.md)
- **Manage evaluation runs** · [Task selection, resume, and reports](docs/users/usage.md) · [Concurrency](docs/users/concurrency.md) · [Image cleanup](docs/users/usage.md#delete-evaluation-images)
- **Measure service performance** · [AgentX concurrency sweeps and trace replay](docs/users/benchmarks/agentx.md)
- **Extend the project** · [Add a Solver](docs/development/add-solver.en.md) · [Add a built-in component](docs/development/add-built-in-plugin.en.md) · [Add an external plugin](docs/development/add-external-plugin.en.md) · [Benchmark development](docs/development/benchmarks.en.md) · [Dataset acceptance](docs/development/benchmark-evaluation-requirements.en.md)
- **Troubleshoot** · [FAQ](docs/users/faq/README.md) · [Error codes](docs/users/reference/errors.md) · [Network retries](docs/users/network-retry.md)

## 🧪 Supported Benchmarks

| Category | Supported benchmarks | What is measured and where to start |
| --- | --- | --- |
| Model + agent harness capability evaluation | GSM8K, MATH-500, MGSM, MMLU, MMLU-Pro, GPQA, DROP, TriviaQA, SimpleQA, HealthBench, HumanEval, DeepSWE, SWE-bench Verified, Terminal-Bench, WorkBuddy, OfficeQA Pro V2, and custom Harbor task packages | Score questions, code, terminal, office, web, and security tasks under each benchmark’s rules. [Benchmarks and requirements](docs/users/README.md#supported-benchmarks) |
| Inference engine performance evaluation (AgentX) | AgentX (`agentx`) | Replay agent requests and measure throughput, time to first token, inter-token latency, and request latency. [AgentX guide](docs/users/benchmarks/agentx.md) |
| Operator performance evaluation (kernel) | kernel (`kernel`) | Verify candidates serially on a local Ascend NPU, compare runtime and speedup, and optionally collect hardware metrics. [Kernel guide](docs/users/benchmarks/kernel-npu.md) · [Example configuration](playbook/kernel/existing.yaml) |

## 📊 Evaluation Results

These runs used **DeepSeek V4.1 Flash 1017**. `tbd` marks a pending evaluation. Scores follow each benchmark’s rules.

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
