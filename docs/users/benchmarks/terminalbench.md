# Terminal-Bench Evaluation

> English | [中文](./terminalbench.zh-CN.md)

Select the built-in profile with `benchmark.name: terminalbench`. The default version is `2.0`; choose `version: "4.0"` or `"4.0.0"` for the 4.0 package.

[Benchmarks](README.md) · [4.0 quick start](../quick-start/terminalbench.md)

## Versions and Configurations

| Version | Configuration and requirements |
| --- | --- |
| 2.0 | [SimpleAgent example](../../../playbook/terminalbench/terminalbench-simpleagent.yaml), Docker and task verifiers |
| 4.0 | [Full example](../../../playbook/terminalbench/terminalbench-4.0.yaml), official v4.0.0 prebuilt archive, pinned SHA-256, amd64 task images |

The 4.0 source contains 66 tasks at the pinned commit; this does not mean all have been executed or passed. Limit the first run to two tasks using the quick start. Default agent budget is 28800 seconds per task; the outer task budget is 86400 seconds. See the [profile](../../../src/plugins/benchmarks/agent-harness/profiles/terminalbench.yaml) for defaults.

## Environments and Support

Use task-declared images first; build Dockerfiles only when no image is declared. Compose service groups start as specified. Unimplemented capabilities such as GPUs are marked unsupported; insufficient resources produce `ENV_RESOURCE_REQUIREMENTS_UNMET`. Removing failing source tasks does not produce full-dataset results.

ARM64 nodes need QEMU/binfmt for amd64 images; see [Docker platforms](../deployment/docker-platform.md). See [Harbor](harbor.md#execution-and-verification-boundaries) for image selection, networking, and artifact delivery, and [preparation](../concurrency.md) for budgets/concurrency.

Results go to the experiment output directory and use native verifier rewards. Start a new run after changing version or source; do not bypass source locks to resume an old experiment.
