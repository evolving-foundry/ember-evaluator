# DeepSWE Evaluation

> English | [中文](./deepswe.zh-CN.md)

DeepSWE evaluates agents on repository changes and test passing. The built-in `deepswe` profile defaults to version `1.1`, pins its Git source, and locks task content.

[User documentation](../README.md) · [Benchmarks](README.md) · [Harbor execution rules](harbor.md)

## Configuration and Execution

Complete [installation](../installation.md) and prepare model variables, Docker, and task images. Models and agents must support tools and code file edits.

| Execution mode | Configuration |
| --- | --- |
| Minimal | [deepswe.yaml](../../../playbook/deepswe/deepswe.yaml) |
| Single-machine SimpleAgent | [deepswe-simpleagent.yaml](../../../playbook/deepswe/deepswe-simpleagent.yaml) |
| Ray + AgentBundle | [deepswe-agentbundle-ray.yaml](../../../playbook/deepswe/deepswe-agentbundle-ray.yaml) |

Check and run from the Evaluator root:

```bash
ember-evaluator doctor playbook/deepswe/deepswe-simpleagent.yaml
ember-evaluator run playbook/deepswe/deepswe-simpleagent.yaml
```

Limit `run.maxTasks` initially. After checking images, model access, and verification, start a new full experiment. See the [profile](../../../src/plugins/benchmarks/agent-harness/profiles/deepswe.yaml) for default tasks, source, and version, and [daily operations](../usage.md) for selection and resume.

## Environment and Verification

Solving uses the prebuilt task image from `task.toml`; independent verification builds `tests/Dockerfile` as declared by the task. If task TOML omits architecture and the image supports only amd64, set `environment.platform: linux/amd64` in experiment YAML. ARM64 nodes also require QEMU/binfmt; see [Docker platforms](../deployment/docker-platform.md).

Task declarations supply CPU, memory, and verification limits. Whole-task and preparation budgets are timed separately; see [concurrency and preparation](../concurrency.md). Native task rewards determine scores; saved results aggregate `f2p`, `p2p`, and `partial`. Do not alter official tests to eliminate failures.

## Common Issues

- Go/esbuild crashes or slow cold builds: [Docker FAQ](../faq/docker.md).
- GitHub 403 despite downloaded data: [data cache FAQ](../faq/downloads.md#why-access-sources-despite-existing-caches).
- CPU visibility, evidence permissions, or cleanup failures: [Docker FAQ](../faq/docker.md).
