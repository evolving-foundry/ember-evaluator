# Benchmark 开发指南

> [English](./benchmarks.en.md) | 中文

本文面向编写或修改 Benchmark 插件的开发者，回答“需要改哪些代码、实现哪些接口、怎样注册和验证”。交付物是插件实现、Profile/patch 和代码回归测试。

开发前先取得[Benchmark 评测要求与验收指南](benchmark-evaluation-requirements.md#2-接入前填写任务规格)中的任务规格；代码完成后按其[分阶段验收](benchmark-evaluation-requirements.md#11-分阶段验收)进行真实运行。官方镜像选择、平台支持、资源限制、超时配置和运行验收只在评测要求与验收指南维护，本文引用这些要求并说明代码实现。

## 选择代码实现位置

Benchmark 一级目录按评测对象分为 Agent Harness、推理引擎性能和算子性能，三类共用现有执行框架、八类组件和 Profile 注册表。类别不出现在 YAML 中，也不改变评分流程。每类内部再按题目转换或协议组织代码；数据获取按外部来源组织：

| 实现方式 | 适用范围 | 需要修改的代码 |
| --- | --- | --- |
| `BenchmarkDefinition + DatasetRecordSource` | 来源可按记录读取，求解输入和结果主要是文本 | Definition 实现公开/私有转换和评分；Source 实现来源固定与记录读取 |
| Harbor Profile | 任务已能用 Harbor 协议、现有 Environment 和 Verifier 表达 | 增加 Profile 声明默认来源与组件组合，不复制协议执行代码 |
| 完整 `Benchmark` | 需要自行构造任务环境、状态交付或新的执行协议 | 实现下节接口，复用已有环境、验证、调度和存储契约 |

不要在 Engine 或 Solver 中增加按 Benchmark 名称判断的业务分支。新增下载来源也不应复制已有题目转换和评分。

| 目录 | 职责 |
| --- | --- |
| `src/plugins/benchmarks/agent-harness/definitions/` | Evaluator 定义 GSM8K 等题库的题目转换、私有答案和评分规则 |
| `src/plugins/benchmarks/agent-harness/protocols/harbor/` | 按 Harbor 任务协议组合环境、产物及 Verifier |
| `src/plugins/benchmarks/index.ts` | 调用三类注册入口；不作为证据解析的导入入口 |
| `src/plugins/benchmarks/inference-engine/agentx/` | 推理负载、保存结果、遥测和统计证据 |
| `src/plugins/benchmarks/operator/kernel/` | 算子精度、计时、profiling、评分与 Python 资源 |
| 各类别的 `profiles/` | 内置默认组合、数据来源政策、版本和场景 |
| `src/infrastructure/datasets/sources/` | 按 Hugging Face、GitHub 等来源实现下载、缓存和来源锁定 |
| `src/infrastructure/datasets/input-readers/` | 读取 JSONL、Parquet、CSV 等记录；Harbor TOML 与 Compose 语义在 Harbor 的 readers 目录 |
| `src/infrastructure/datasets/cache.ts` | 不同数据来源共用的内容寻址缓存 |

![数据适配器负责来源和缓存，Benchmark 生成公开任务与私有验证材料，Solver 不读取隐藏答案](../users/imgs/04-framework-benchmark-boundary.png)

图中的分叉表示材料的交付边界：公开输入传给 Solver，私有材料保留给验证流程；`runTask` 调用 `Benchmark.verify()`，并传入求解结果及按声明交付的状态。Solver 不直接调用验证器。下载来源和题目评分分别由 adapter 与 Benchmark 负责。

## 新需求的修改入口

| 需求 | 实现和注册位置 | 验证重点 |
| --- | --- | --- |
| 问答、选择题、代码题与自定义评分 | agent-harness/definitions、来源配置、Profile、agent-harness/index.ts | 公开输入与私有答案隔离、评分和来源恢复 |
| Harbor 任务集 | agent-harness/profiles；协议差异才修改 protocols/harbor | 单步/多步、状态传输、验证资源与取消 |
| 独立 Agent 测评 | agent-harness 下独立目录，实现 Benchmark，按需增加 Solver/Verifier | 当前准备/求解/验证契约能否表达流程；无需继承 DefinedBenchmark |
| 推理引擎负载 | inference-engine 下的 Benchmark、负载 Solver、evidence 和 Profile | 测量条件、证据完整性、离线指标 |
| 算子测评 | operator 下的 Benchmark、执行后端、精度/计时证据和 Profile | 错误分类、精度门槛、计时和 profiling |
| 新 Agent 框架 | runtimes 下安装描述/桥接，以及对应 Solver | 进程协议、认证脱敏、取消和运行产物 |
| 新生命周期或跨任务状态 | 先设计 core/contracts，再调整执行、准备、调度和恢复 | 并发隔离、重试、续跑和资源释放 |

在所属类别的 index.ts 注册 Benchmark 与 Profile；新增 Profile 不改变原有 ID、继承和跨类别重名检查。根 plugins 入口只组合注册函数。只有已有多个调用方的功能才进入 shared。专属 Metrics/Reporter 保留在各自角色目录，直接引用明确的证据模块。

AgentX 的 evidence 只读取保存结果，依赖链不加载安装器、采样进程或网络探测。Solver 调用 runtimes/agentx 后把原始输出交给 evidence。Runtime 不反向引用 Benchmark；双方共享的版本常量放在无 I/O 的 runtime 叶子模块。

单元测试放 tests/unit，跨组件流程和注册/配置/续跑测试放 tests/integration，可复用输入放 tests/fixtures。至少验证正常、失败、取消、资源释放和离线报告；真实 Docker、Ray、NPU 或模型验收单独记录，不能用 Mock 结果代替。

## 未来记忆评测的接口边界

可能的流程是“环境就绪 → 写入历史 → 提问 → 验证 → 清理”。历史解释、写入顺序和评分属于 Benchmark，公开问题由 Solver 执行，核心负责超时、取消、记录与释放。样本内多轮状态和跨样本共享状态需要分别明确隔离与恢复要求。

当前 Benchmark.prepare() 在环境创建前执行，不能直接初始化已经运行的记忆服务；现有多步任务还有 bash setup.sh 初始化约定。现有接口不能任意增加新的生命周期阶段。实际需求超出这些边界时，先设计明确的契约，再修改执行和调度流程。本仓库没有为未来记忆评测增加空 hook、通用工作流 DSL 或占位服务。

## 完整 Benchmark 接口

[Benchmark](../../src/core/contracts/benchmark.ts) 有四个必需方法：

| 方法 | 实现要求 |
| --- | --- |
| `resolveSource(previous, signal)` | 返回锁定来源；恢复时检查 `previous`，不能将变化后的内容视为原来源 |
| `enumerate(source, signal)` | 产生唯一、稳定的 `TaskRef`；固定记录顺序，避免选题和恢复时 ID 变化 |
| `prepare(ref, source, signal)` | 返回 `PreparedTask`，并保证 `input.id === ref.id`；不启动正式求解 |
| `verify(task, result, session, signal)` | 根据私有材料和交付状态验证结果，返回合法 `VerifyResult` |

[PreparedTask](../../src/core/contracts/task.ts) 用 `input` 保存公开输入、`verification` 保存私有描述；`solveEnv`、`verifyEnv` 和 `transfer` 声明环境与状态传输。`shared` 模式复用求解环境，`verifyEnv` 和 `transfer` 都必须为 `null`。独立验证的环境与传输必须配套，不能在 Benchmark 中假定执行节点共享文件系统。

任务要求的平台和资源填写到 [EnvironmentSpec](../../src/core/contracts/environment.ts) 的 `platform`、`resources`。`phaseTimeoutSeconds.solve`、`.verify` 只表示执行阶段上限；`preparationTimeoutSeconds.solve`、`.verify` 分别表示两个环境的准备基础时限。`planRun()` 返回任务及 `preparation.defaultTimeoutSeconds`，Scheduler 提供本节点有效准备并发，公共准备函数按基础值乘 `min(C, 10)` 计时，默认不设置整轮上限。外部 Scheduler 调用准备回调时，通过 `TaskPreparationContext` 传入 `concurrency`、`defaultTimeoutSeconds`、`roundSignal` 及可选 `environmentTimeoutSeconds`；共享描述工作使用 roundSignal，单任务阶段使用自己的信号。相关配置见[环境准备时限](../users/config.zh-CN.md#环境准备时限)。

可选 `validateRun(config)` 只做跨组件配置检查，bootstrap、dry-run 和 engine 都调用它；不得分配资源。`discloseAnswer()` 用于受控答案证据，不改变 Solver 的公开输入；`validateSourceOnCompletedResume` 用于已完成运行恢复时仍需检查来源的实现。

## Evaluator 定义题目转换与评分

`definitions/benchmark-definition.ts` 中的 `BenchmarkDefinition` 定义记录分区、可选预处理和辅助数据加载、`prepare()` 题目转换及 `verify()` 评分。公开题目与私有验证数据分别保存在 `input` 和 `verification` 中，Solver 不接收私有答案。

`definitions/defined-benchmark.ts` 中的 `DefinedBenchmark` 接收 `DatasetRecordSource`，该接口提供 `resolve(previous, signal)` 和 `rows(lock, selection, signal)`。来源可以来自任意实现这两个方法的 adapter；Benchmark 不自行创建 HF 下载器。

`BenchmarkDefinition.prepare()` 只返回 `input` 和 `verification`，`DefinedBenchmark` 填入默认环境；不能在 Definition 中直接声明完整的任务资源和阶段时限。需要指定任务容器、状态传输或独立验证环境时，选择 Harbor 或完整 `Benchmark`；只有额外私有验证进程时，可使用下述 `verificationRuntime`。

GSM8K 示例：

1. `definitions/gsm8k.ts` 定义 `gsm8kDefinition`：转换 question/answer 字段、生成 Prompt、提取和比较答案。
2. `definitions/index.ts` 的内置组合清单关联该 Definition 和 `openai/gsm8k` 的文件选择声明。此处维护下载哪些数据的政策，不执行下载。
3. `plugins/benchmarks/agent-harness/index.ts` 通过 Cordis 注册 `gsm8k`。工厂创建 `HuggingFaceFilesSource`，将其注入 `DefinedBenchmark`。
4. 实际网络访问、HF_TOKEN、镜像地址、内容缓存和来源锁均由 `infrastructure/datasets/sources/huggingface/` 实现。

给其他来源实现 adapter 后，可以复用相同 Definition；不需要修改题目转换、评分或 Engine。第三方插件可从包根导入 `DefinedBenchmark`、`BenchmarkDefinition` 和 `DatasetRecordSource`，通过现有 Cordis 注册与显式 patch 加载。注册和校验阶段不能启动下载或评测。公共契约和复用能力由包根导出。

`benchmark.name`、`cacheDir`、`hfToken`、`dockerExecutable` 由所选组件及 Profile 校验。hfToken 可使用 `${HF_TOKEN}` 从 YAML/SDK env 获取，旧 hfTokenEnv 不再接受。含凭据的组件通过 `secretFields: ["hfToken"]` 声明 Ray 投递时删除该字段，节点读取自身 HF_TOKEN。HF 配置项属于当前内置来源组合，并非所有定义型题库必须提供的参数。

Definition 需要额外验证进程时，可通过 `verificationRuntime(context)` 返回运行环境实现，`DefinedBenchmark` 会交给框架准备和释放。HumanEval 的 Python 镜像在环境准备阶段解析为本机镜像 ID，评分代码只在已创建的验证容器内运行。接口及失败处理要求见[验证器运行环境](plugins.md#验证器运行环境)。

## Harbor 题库

`protocols/harbor/source.ts` 维护协议来源政策，`task.ts` 解析任务，`verify.ts` 将上游 Verifier 奖励映射为标准结果，`compatibility.ts` 维护兼容约束。`harbor-benchmark.ts` 通过公共契约组合这些能力，实际 shell/Python 验证仍在已有 Verifier 插件中。

任务包已经符合 Harbor 且执行能力已受支持时，增加继承 `harbor` 的 Profile，复用通用 Benchmark 与 Verifier。确有特殊执行行为时，修改负责该行为的协议 adapter 或注册 Verifier，不复制整套执行流程。镜像选择和配置实例引用[评测要求与验收指南](benchmark-evaluation-requirements.md#4-官方镜像优先于-dockerfile)，完整 Harbor 字段见[通用 Harbor 指南](../users/benchmarks/harbor.zh-CN.md)。

## 数据来源 adapter

`sources/huggingface/` 处理 Hub 文件和 endpoint；`sources/github/` 处理 Tree/blob 与目录物化；`sources/local/` 读取本地目录快照；`sources/http/` 下载并安全解压固定摘要的 HTTP 压缩包。HTTP 下载复用 `datasets/cache.ts`，通用目录物化负责平台限制与原子发布，不解析题目或实现评分。当前 `local/` 和 `http/` 提供目录型数据接入，并不自动把任意目录或压缩包转换为定义型题目的记录。

## 任务准备失败的处理

使用公共 `planBenchmarkRun()` 时，`prepare()` 可以用 `new EvaluatorError("TASK_DATA_INVALID", message)` 明确声明本题数据无效，或用 `BENCHMARK_UNSUPPORTED` 声明本题协议不受支持。规划函数把该题写入 `preparationFailures`，继续检查剩余题；是否执行其余题由 `run.onError` 决定。插件从包根导入 `EvaluatorError`，不需要借用 Harbor 错误码。

只有异常自身显式声明的这两种单题错误可以采用上述行为；来源变化、配置错误和未知异常仍终止规划。普通 `Error`、消息中的错误码、未知 `UNSUPPORTED_*` 前缀以及仅出现在 cause 中的单题错误码都不构成声明。有明确网络证据的任务来源失败保留有限补测行为；显式运行级错误不会因此被降为单题失败。Harbor 也直接使用这两个通用码，不保留旧码或转换表。

修改下载实现要验证来源锁和离线恢复；修改 Definition 要验证公开题目、私有答案边界和评分；修改默认组合要验证配置解析。重命名内部文件不修改任务 ID 或数据来源标识；源码和发布目录变化仍参与包摘要校验，续跑不能绕过插件版本一致性检查。

## 生命周期与资源所有权

| 方法/阶段 | 职责与允许的 I/O |
| --- | --- |
| import / apply / validate / Profile | 只声明和校验，不下载数据、分配容器或调用模型 |
| resolveSource | 锁定来源、版本和内容摘要，允许受 AbortSignal 控制的来源 I/O |
| enumerate | 依据锁定来源枚举唯一、稳定的 TaskRef，不启动求解 |
| prepare / planRun | 构造公开任务与私有验证材料；允许物化已锁定输入，不创建正式求解进程或模型调用；planRun 返回完整任务计划和准备预算 |
| Solver.prepare / solve | 只消费公开输入和执行环境；持有自己的子进程/PreparedSolver 生命周期，不读取 verification |
| Benchmark.verify / Verifier | Benchmark 解释答案或测量证据；独立 Verifier 负责其私有执行环境的验证协议，不负责调度和存储 |
| Metrics / Reporter | 只从 ResultSnapshot 离线计算；工厂上下文只有 configDirectory/resolvePath，不提供模型认证 |

一个命令持有一个 Registry，在配置和装配间显式共享；独立 loadConfig/bootstrap 调用持有自己的生命周期。所有选中组件先校验，再调用工厂。资源由创建它的 Cordis effect、Session 或 PreparedSolver 释放，失败和取消也遵循同一规则。

所有 I/O、子进程和容器操作都要传递并响应 `AbortSignal`。仅用 Promise 超时停止等待，不能保证底层工作停止；取消后必须停止写入、回收资源，不能把仍在写入的目录交给后续任务。长同步计算要避免阻塞事件循环，否则取消信号无法及时处理。

## 评分结果与诊断证据

`VerifyResult.score` 缺省表示没有测得分数，不等于零分；`passed: null` 表示没有测量二元正确性。质量评测可以只有连续 score，不应为此虚构阈值。官方奖励、成功阈值和报告分母应先按[评分口径](benchmark-evaluation-requirements.md#9-核对官方评分与结果口径)确认，再实现对应返回值。

AgentX 等无 ground truth 的性能协议使用 `Benchmark.evaluationKind = "performance"`，通过公开任务 `payload` 传递负载，Solver 通过 `observations` 返回可离线处理的摘要。验证检查 Workload 身份、产物格式和测量完整性，返回 `passed: null` 且不填写 score；核心将评分状态记为 `not-applicable`。准备模式与 evaluationKind 独立，Core 不理解具体 Trace 格式。协议实例见 [AgentX](../users/benchmarks/agentx.zh-CN.md)。

评分途中需要保留诊断证据时，可从包根导入 `VerificationError`，抛出 `new VerificationError(message, jsonEvidence, { cause })`。Core 将脱敏后的证据保存在无 score、passed:null 的 verdict.details，attempt 仍为无效或取消；离线统计不会将其计入合法评分，续跑会重新执行。普通异常继续按现有失败路径处理，不需要为每种 Benchmark 增加异常类。

轨迹路径由框架写入 `AttemptRecord.trajectory`，有无 verdict 都使用这个位置。`VerifyResult` 不接受 `trajectory` 字段；Verifier 只返回验证结果，不能通过旧字段重复声明证据位置。

## 发布默认 Profile

Profile 是配置元数据，通过 Cordis 注册，仍由现有 Benchmark、Solver 等执行组件提供行为：

```js
export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.registerProfile({
    id: "my-benchmark",
    role: "benchmark",
    extends: "harbor",
    plugin: { name: "harbor", config: { /* 固定 source、tasks、scoring */ } },
    defaults: { run: { timeoutSeconds: 3600 } },
  });
}
```

类型 ConfigProfile、UserConfig、ResolvedProfiles 与纯函数 resolveConfig 从包根导出。Profile 支持 versions、scenarios、defaultVersion、defaultScenario；Web 使用的 `$default` 是 verifier.service 的默认服务绑定标记。Solver Profile 使用 role: solver，并通过 plugin 选择真实 Solver。模块通过现有显式 --patch 加载，注册与校验阶段不得启动评测资源。

内置声明位于各类别的 profiles 目录。增加继承 harbor 的 YAML 即可发布使用相同协议的数据集，无需修改 Loader 或 Engine。外部插件可以用包根导出的 readProfileDirectory 读取自己的随包 YAML，再逐个 registerProfile。重复标识、继承环、缺失父项均报错。文件必须随包发布并纳入节点版本摘要；本仓库构建已经包含内置 Profile YAML。

## 三种可运行的接入示例

完整文件在 [tests/fixtures/benchmark-examples](../../tests/fixtures/benchmark-examples)，每种示例均有两道题。插件只从包根导入，使用同一个 [patch.yaml](../../tests/fixtures/benchmark-examples/patch.yaml)，无需修改 Core 或内置注册表。

本节用于开发时验证插件发现、配置和执行链路。真实数据集的官方镜像、平台、资源和评分验收使用[评测要求与验收指南](benchmark-evaluation-requirements.md#11-分阶段验收)，不能由夹具测试替代。

| 接入方式 | 实现与配置 | 应用场景 |
| --- | --- | --- |
| Definition + Source | [definition.mjs](../../tests/fixtures/benchmark-examples/definition.mjs)、[source.mjs](../../tests/fixtures/benchmark-examples/source.mjs)、[definition.yaml](../../tests/fixtures/benchmark-examples/definition.yaml) | 来源可按记录读取，转换公开问题并用私有答案评分 |
| Harbor Profile | [harbor-profile.mjs](../../tests/fixtures/benchmark-examples/harbor-profile.mjs)、[任务目录](../../tests/fixtures/benchmark-examples/harbor)、[harbor.yaml](../../tests/fixtures/benchmark-examples/harbor.yaml) | 已有 instruction.md、task.toml 和 tests/test.sh，复用 Harbor 生命周期 |
| 完整协议插件 | [protocol.mjs](../../tests/fixtures/benchmark-examples/protocol.mjs)、[protocol.yaml](../../tests/fixtures/benchmark-examples/protocol.yaml) | 需要自行控制来源、TaskRef、环境声明和验证；仍实现同一个 Benchmark 接口 |

先按[安装指南](../users/installation.zh-CN.md)安装依赖并构建，设置 `MODEL_NAME`、`MODEL_ENDPOINT`、`MODEL_API_KEY`，在仓库根目录执行（WSL / Bash）：

```bash
ember-evaluator benchmark list --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator benchmark info example-definition --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator doctor tests/fixtures/benchmark-examples/definition.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator run tests/fixtures/benchmark-examples/definition.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
```

将 `definition.yaml` 替换成 `protocol.yaml` 即运行完整协议示例，替换成 `harbor.yaml` 即运行 Harbor 示例。Harbor 需要可用的 Docker 和固定 Node 镜像，模型需要能调用工具并写入任务文件。`doctor` 执行下载和构建探针，不调用模型；实际运行可能下载运行时。结果目录在仓库 `.scratch/benchmark-examples/`，将 `run` 输出的目录传给 `ember-evaluator report <run-dir>` 即可离线重建，无需认证。报告重建根据已保存的报告插件来源装配 Metrics/Reporter，命令无需重复传 patch。

需要从 `init` 生成配置时，把示例数据复制到输出目录，使 Profile 的相对路径仍然成立：

```bash
mkdir -p .scratch/benchmark-init
cp tests/fixtures/benchmark-examples/questions.json .scratch/benchmark-init/
ember-evaluator init --benchmark example-protocol --output .scratch/benchmark-init/experiment.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator doctor .scratch/benchmark-init/experiment.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
ember-evaluator run .scratch/benchmark-init/experiment.yaml --patch tests/fixtures/benchmark-examples/patch.yaml
```

`init` 不覆盖已有文件。Harbor 初始化时将 `harbor/` 目录一并复制到配置旁边。换用其他来源时修改 `benchmark.config.path`（记录示例）或 `benchmark.config.source`（Harbor）；路径始终相对实验 YAML，不相对 patch。

### 示例的边界

两个记录示例共享的 `source.mjs` 每次读取都检查取消、记录结构与内容身份，恢复时拒绝来源改变；它只服务这个两题示例。完整协议显式校验 TaskRef，答案只放在 `verification`。Harbor 的私有测试只在验证阶段注入，不能放进公开镜像或 Solver 输入。需要固定原始文件字节时，应像已有数据 adapter 一样在 SourceLock.files 记录字节摘要；示例 revision 固定的是解析后的题目内容。

示例不启动后台资源，因此没有额外 dispose；接入进程或临时目录后，应由创建者接入 Cordis effect、Session.dispose 或 PreparedSolver.dispose。失败与 AbortSignal 触发后同样释放，不能把一个已解锁但仍在写入的目录交给后续任务。可选 `planRun` 用于已有批准备流程；普通协议可以只实现 `resolveSource`、`enumerate`、`prepare` 和 `verify` 四个必需方法，不需要增加新的框架抽象。

复杂性能协议可继续参考 AgentX：来源/测量点在 Benchmark，请求回放在 adapter，统计和报告只读已保存 observations；不新增插件类别。

## 插件回归测试

执行 `pnpm build` 后运行 `pnpm test --run tests/integration/benchmark-examples.test.ts`，检查上述三个插件的来源锁、唯一 ID、序列化、公开/私有边界、来源改变与取消；其中两个记录示例还用受控 Solver 跑通发现、doctor、运行、离线报告和续跑。这个测试不发送模型请求，也不启动 Docker；Harbor 的实际 Docker 执行须单独验收。

资源失败路径继续复用[插件装配与释放测试](../../tests/integration/registry-lifecycle.test.ts)、[执行生命周期测试](../../tests/integration/engine.test.ts)、[AgentX 完成/取消/续跑测试](../../tests/integration/agentx.test.ts)。测试 fixture 中的内存来源和模拟进程可复用，不需要新测试 SDK。

类型检查、构建和测试命令见[开发规范](../../AGENTS.md#代码开发规范)。测试记录区分受控回归与真实运行，完整交付仍需引用接入验收结果。

[返回开发文档](README.md) · [Benchmark 评测要求与验收指南](benchmark-evaluation-requirements.md) · [插件开发与加载](plugins.md)
