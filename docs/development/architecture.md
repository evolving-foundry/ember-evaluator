# 源码架构与执行流程

> [English](./architecture.en.md) | 中文

本文说明当前实现的模块职责、调用关系和资源所有权，随代码变化维护。新增代码的仓库规则见 [AGENTS.md](../../AGENTS.md)，组件接口和加载方法见[插件开发与加载](plugins.md)，新增题库的具体步骤见 [Benchmark 开发指南](benchmarks.md)。

## 目录职责

| 位置 | 负责的行为与主要入口 |
| --- | --- |
| [src/index.ts](../../src/index.ts) | 显式导出包根 API 和公共类型；内部模块直接引用所属实现，不通过包根转引 |
| [src/cli.ts](../../src/cli.ts)、[cli/](../../src/cli) | 安装进程信号处理、定义和分派命令、显示终端进度、设置退出码 |
| [application/](../../src/application) | 完成运行、报告、预热、补测、诊断等用户操作；创建和释放组件，选择本地执行或 Ray Jobs |
| [config/](../../src/config) | 读取 YAML、展开环境变量和 Profile、校验与脱敏；不创建 Cordis Context 或运行组件 |
| [core/](../../src/core) | 定义组件契约；执行来源锁定、选题、准备、调度、attempt、恢复、结果和产物处理 |
| [plugins/](../../src/plugins) | 实现 Benchmark、Verifier、Environment、Solver、Metrics、Reporter、Store、Scheduler 八类组件 |
| [runtimes/](../../src/runtimes) | 保存特定外部程序的安装描述、调用桥接、输入输出协议和资源，如 Pi、DSH、AgentBundle、AgentX |
| [infrastructure/](../../src/infrastructure) | 实现进程、Shell、容器、网络、数据下载、安装锁、IPC、传输和摘要读取等 I/O 能力 |

core 的契约位于 `contracts/`；执行在 `execution/`，准备在 `preparation/`，恢复和补测资格在 `recovery/`，选题在 `selection/`，结果和来源规则在 `results/`，文件清单与轨迹在 `artifacts/`。完整目录树见[仓库目录结构](../../AGENTS.md#仓库目录结构)。

config 负责配置文件读取和解析，不加载插件模块。[plugin-patch.ts](../../src/config/plugin-patch.ts) 读取 patch、校验条目并计算 patch 摘要；[load-module.ts](../../src/application/plugins/load-module.ts) 按 patch 所在目录定位模块、读取版本或计算文件摘要并执行动态 import。配置文件读取仍有 I/O，不能把整个 config 当作纯函数集合。core 也包含文件读写，并通过契约触发组件 I/O；其约束是不依赖应用装配和具体组件实现。infrastructure 可以使用 Evaluator 契约，但不决定题目得分、补测资格或调度策略。

## 允许的源码依赖

下表描述仓库源码之间的允许关系，不限制 Node 内置模块和第三方包。

| 调用方 | 允许引用的目录 |
| --- | --- |
| core | core |
| config | config、core |
| infrastructure | infrastructure、core、允许清单中的 config 模块 |
| runtimes | runtimes、infrastructure、core、允许清单中的 config 模块 |
| plugins | plugins、runtimes、infrastructure、core、允许清单中的 config 模块 |
| application | application、config、core、plugins、runtimes、infrastructure |
| cli | cli、application、core |

`src/index.ts` 和 `src/cli.ts` 是公开导出和进程入口，不受上表的目录限制。其他内部模块不得引用包根或用 `ember-evaluator` 自引用绕过规则。config、infrastructure、runtimes 还禁止引用 `core/execution/`。

运行 `pnpm check:dependencies` 检查这些限制。规则和 config 允许清单维护在 [check-dependencies.mjs](../../scripts/check-dependencies.mjs)，[dependency-baseline.json](../../scripts/dependency-baseline.json) 必须保持为空。新增 config 文件不会自动获得其他层的引用权限。

检查覆盖静态导入、类型导入、再导出、字符串动态 import、可解析 require、缺失的相对模块和可执行导入循环；纯类型引用仍受目录规则约束，但不计入初始化循环。以下内容需要另外检查：

- plugins 内部允许跨角色引用，脚本不能判断引用是否有合理的业务用途。
- config 允许清单不是对函数无副作用的自动证明。
- 变量拼出的模块地址、`assets/` 中的代码、Python 依赖和资源 URL 不由导入图完整覆盖。
- 资源复制、进程入口、取消和清理行为需要构建、集成及分发验证；零依赖违规不能替代这些验证。

## 运行流程与资源所有权

CLI `run` 和 SDK `Evaluator.run()` 使用 [application/run.ts](../../src/application/run.ts) 的 `executeExperiment`。普通执行路径如下：

1. [plugins/open-registry.ts](../../src/application/plugins/open-registry.ts) 创建 Cordis Context，注册内置组件和显式 patch 插件。
2. [application/config.ts](../../src/application/config.ts) 将该注册表的 Profile 和校验能力传给 config，读取并校验实验；[plugins/create-components.ts](../../src/application/plugins/create-components.ts) 的 `createRunComponents(registry, config, directory)` 使用同一注册表创建组件。
3. [run-engine.ts](../../src/application/run-engine.ts) 提供补测控制和运行身份读取，再调用 [core/execution/engine.ts](../../src/core/execution/engine.ts)。
4. core 处理来源、选题、恢复和准备，通过 Scheduler 调度，[run-task.ts](../../src/core/execution/run-task.ts) 执行 attempt。
5. application 保存指标与报告，并在退出时关闭注册表，通过 Cordis effect 释放组件资源；失败和取消也进入清理流程。

`runTask()` 准备任务、推进步骤、归档证据并保存结果。[run-attempt-step.ts](../../src/core/execution/run-attempt-step.ts) 执行单步求解、收集、传输和验证，失败后在求解环境关闭前补收集产物。[attempt-resources.ts](../../src/core/execution/attempt-resources.ts) 创建并释放环境会话、Solver 句柄和私有验证器，负责求解与验证之间的环境切换。多步任务在归档本步证据前关闭本步的私有验证器和独立验证环境，再把求解环境交给下一步。

`createRunComponents` 和 `createBenchmark` 必须接收已有注册表，不负责打开或关闭注册表。前者返回不含 `dispose()` 的 `RunComponents`，后者直接返回 Benchmark；工厂创建的资源一直由该注册表管理，装配失败也由注册表所有者的 `finally` 清理。

公开 [bootstrap](../../src/application/plugins/bootstrap.ts) 自行打开注册表，失败时关闭，成功时返回 `BootstrappedComponents`（组件字段加 `dispose()`）。其签名为 `bootstrap(config, directory, patchPath?, onWarning?, imageConfigFingerprint?)`，调用方在 `finally` 中调用返回值的 `dispose()`。重复释放由注册表处理。

`executeExperiment` 负责关闭它使用的注册表，包括通过内部 `execution` 参数转交的注册表；`executeWarmup` 自建的注册表由它关闭，通过 `execution` 借用的注册表由 Jobs 入口关闭。预览、诊断和 Ray worker 入口在退出时关闭各自注册表。Worker 执行函数必须接收注册表，结果上传前不执行无效的组件释放调用。直接调用公开 `runEngine` 时，它只关闭自己创建的补测控制，不创建注册表、不替换组件，也不关闭调用方资源。

Benchmark 准备公开输入和私有验证材料；Solver 只接收公开任务与执行环境；Benchmark.verify 或私有验证运行时使用验证材料评分；Store 保存结果和产物。`Benchmark.prepare()` 在环境创建前执行，现有接口不支持任意新增“环境就绪后”的生命周期阶段，具体限制见 [Benchmark 开发指南](benchmarks.md#未来记忆评测的接口边界)。

离线报告通过 [application/report/](../../src/application/report) 单独加载 Metrics 和 Reporter 的注册入口，读取已保存结果并调用所选组件，不加载内置组件总入口，也不重新运行 Solver。第三方报告组件通过同一个 loadPluginModule 加载，并继续检查保存的插件版本。修改证据格式时需同时检查结果读取、续跑、Metrics 和 Reporter。

## 补测、Ray 与 Docker

Engine 在 `admitRetryRequests` 中读取结果、检查资格、预留队列并填写请求绑定。`prepareRetryTask` 为新的 attempt 重新规划并准备依赖。内部队列把任务和准备结果一起传递，区分按需准备、已生成描述、依赖就绪和准备失败。执行器通过 `attemptId` 取回本次准备结果。流水线的就绪时间只属于对应的 attempt。 [准备状态定义](../../src/core/preparation/task-preparation.ts)

公开 Scheduler 仍接收 `TaskJob`。Ray 的准备凭证保留在 worker 上，worker 验证凭证后才把任务作为依赖就绪交给执行器。

补测由 [application/retry-control/mailbox.ts](../../src/application/retry-control/mailbox.ts) 负责请求文件、锁、事务和 IPC，core 负责资格检查与队列预留。交接接口在 [core/contracts/retry-control.ts](../../src/core/contracts/retry-control.ts)。在线请求先预留任务，保存请求状态和 attempt 绑定成功后才 `commit` 入队，最后通过 `finally release` 释放预留。保存失败不得留下已入队任务；相同请求不得重复调度。关闭控制通道前要停止接收并等待在途事务。

| 操作 | 实现位置 |
| --- | --- |
| 提交、跟踪 Ray Jobs 和下载远程结果 | `application/ray/`，调用 `infrastructure/ray/` 客户端 |
| 将 attempt 调度到 Ray 节点 | `plugins/schedulers/ray/`，使用 Ray 协议和 Python driver |
| 节点加载插件并执行任务 | `application/ray/node-worker.ts`，调用应用装配和核心执行流程 |
| 准备 Docker 镜像、运行时及会话 | `plugins/environments/docker/environment.ts` |
| 会话内执行、传输、阶段切换和关闭 | `plugins/environments/docker/session.ts` |
| 共用 Docker 命令、镜像和构建工具 | `infrastructure/containers/` |

Ray Jobs 部署与 RayScheduler 的任务调度处于不同层次。Jobs 入口直接调用 application 的操作函数，不通过 CLI 参数解析执行。Docker 准备实现仍包含多种镜像策略；现有拆分不表示每种策略已有独立模块。

Docker 的 `materialize()` 和按需 `prepare()` 共用 `prepareDependencies()`，准备主容器、网关和 Compose 服务的镜像及运行时。`prepare()` 有凭证时先校验本地镜像，再把已确定的镜像交给 `startSession()`。启动主容器和网关时使用 `--pull never`，Compose 还使用 `--no-build`。启动失败时先清理已创建的容器、Compose 项目和网关，再释放镜像租约。启动成功时，容器、网关、Compose 项目和租约交给 `DockerSession.dispose()`。

## Benchmark 与插件注册

Benchmark 分为 `agent-harness/`、`inference-engine/`、`operator/`，各自保存所属 Profile 并在本类 `index.ts` 注册。分类不增加 YAML 类别字段，也不在核心执行流程中按类别分支。具体新增位置见 [Benchmark 开发指南](benchmarks.md#新需求的修改入口)。

[plugins/index.ts](../../src/plugins/index.ts) 组合注册入口。Benchmark、Solver、Environment、Verifier、Store、Scheduler 使用各自入口；Metrics 和 Reporter 分别由 [metrics/index.ts](../../src/plugins/metrics/index.ts) 和 [reporters/index.ts](../../src/plugins/reporters/index.ts) 注册。外部插件通过显式 `--patch` 加载，省略参数不扫描默认目录，配置方法见[插件开发与加载](plugins.md)。

同一功能可以跨角色目录。例如 AgentX 的输入和证据在 `plugins/benchmarks/inference-engine/agentx/`，负载调用在 `plugins/solvers/agentx-replay.ts`，安装和桥接在 `runtimes/agentx/`，指标与报告分别在 metrics 和 reporters。`evidence/` 直接解析保存的结果，不通过注册入口加载安装器或采样进程；共享版本信息来自无 I/O 的 `runtimes/agentx/versions.ts`。

构建时，[build-plugins.mjs](../../scripts/build-plugins.mjs) 扫描仓库根目录下的 `plugins/*/ember-plugin.json`，按清单构建并把产物和 patch 写到 `dist/plugins/<id>/`。运行时通过显式 patch 加载这些插件。清单用于构建和复制产物，CLI 命令由宿主定义。

## 构建、发布与维护

[package-runtime.mjs](../../scripts/package-runtime.mjs) 在 TypeScript 编译后复制 Profile、Python、运行时资源及许可证，生成进程入口和完整性清单。源码没有 `adapters/`；发布包中的少量旧路径由构建生成，服务于已有部署。具体兼容路径和独立安装包的验证命令见[发布进程入口](plugins.md#发布进程入口)。

Pi 构建只重写 runner 依赖副本，准备模块继续使用正式目录中的依赖和资源。兼容目录包含独立运行所需文件和清单。内置 Benchmark 的 Profile 和专属资源由打包脚本显式复制。兼容文件和仓库插件产物都在计算包摘要前生成。

修改跨模块调用时运行依赖检查、类型检查和相关测试；改动构建或运行时资源时还要构建并验证实际安装包。测试位置、组件验收和真实环境要求见[插件开发与加载](plugins.md)、[运行时与并发检查](runtime-validation.md)及[仓库开发规范](../../AGENTS.md#开发流程)。

职责、调用关系或所有权发生变化时更新本文及对应英文版本；组件细节在插件/Benchmark 指南维护，用户操作在用户指南维护。日期目录中的 design/task 保存决策与当次验证证据，不作为长期架构说明的唯一入口。
