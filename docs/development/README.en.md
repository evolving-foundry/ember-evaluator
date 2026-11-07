# Development Documentation

> English | [中文](./README.md)

These guides are for developers modifying Evaluator or writing plugins. For installation, experiment execution, and troubleshooting, see the [user documentation](../users/README.md).

| Goal | Guide |
| --- | --- |
| Build an independent plugin, load it by file or package name, and validate CLI, SDK, and Ray integration | [Integrating external plugins](external-plugins.en.md) |
| Learn the eight component types, register metrics, and explicitly load patches | [Plugin development and loading](plugins.en.md) |
| Integrate datasets: check official requirements, configure images, platforms, resources, and timeouts, and verify acceptance | [Benchmark requirements and acceptance](benchmark-evaluation-requirements.en.md) |
| Write plugins: implement contracts, register profiles, manage resources, and run regression tests | [Benchmark development](benchmarks.en.md) |
| Throw structured errors and preserve diagnostics | [Plugin error handling](diagnostics.en.md) |
| Check Office Ray slots and the AgentX bridge protocol | [Runtime and concurrency validation](runtime-validation.en.md) |
| Find directory responsibilities, dependency rules, execution order, and resource ownership | [Source architecture and execution flow](architecture.en.md) |

Store intermediate designs and implementation records in `docs/design/` and `docs/tasks/` under the [documentation rules](../AGENTS.md). Keep fixture usage and controlled validation here; user guides describe current operations, results, and limitations.
