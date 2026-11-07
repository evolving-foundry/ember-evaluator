# 插件开发与加载

> [English](./plugins.en.md) | 中文

本文介绍八类组件接口、可运行的指标插件、显式 patch 与 Ray 节点部署。示例中的源码命令和 `experiments/` 目录均以 Evaluator 仓库根目录为基准。

[返回项目主页](../../README.zh-CN.md) · [用户手册](../users/README.zh-CN.md)

## 源码与注册位置

仓库内组件在各角色的 index.ts 注册，Metrics 和 Reporter 分别使用 metrics/index.ts 和 reporters/index.ts；Benchmark 再分 agent-harness、inference-engine、operator 三个注册入口。application/plugins/open-registry.ts 创建 Cordis 注册表并注册插件，load-module.ts 定位和导入插件模块、读取版本，create-components.ts 使用已有注册表创建组件，bootstrap.ts 提供自行创建和释放注册表的公开入口；config/plugin-patch.ts 只读取 patch、校验条目和计算摘要，不执行插件模块。外部插件仍从 ember-evaluator 包根导入公共接口，不依赖这些内部目录。完整调用关系和资源所有权见[源码架构与执行流程](architecture.md)，新增 Benchmark 的具体位置和流程限制见[Benchmark 开发指南](benchmarks.md#新需求的修改入口)。

运行 `pnpm check:dependencies` 检查导入、目录依赖和可执行模块循环；允许关系和未覆盖范围见[依赖规则](architecture.md#允许的源码依赖)。插件使用显式 patch 加载，不支持 manifest 自动发现或插件声明 CLI 命令。

### 发布进程入口

`pnpm build` 生成包根与 CLI 入口，并保留 `dist/adapters/ray/{node-worker,jobs-entry,jobs-retry-entry,jobs-gateway}.js`、Ray 的 `python/requirements.txt`、`dist/adapters/harness/pi/` 独立运行包及 `dist/adapters/harness/agentx/assets/ascend_metrics.py`。现有部署路径仍可用，仓库内部引用改用新目录。生成的入口和资源均参与包摘要计算。

将实际打包产物及运行依赖安装到 checkout 外的目录后，从仓库执行 `node scripts/verify-distribution.mjs <安装后的包目录>`。目标目录不能带 src 或 scripts。检查覆盖 CLI、包名导入的 SDK 执行/报告、Pi 协议、worker 任务/镜像维护/版本拒绝、Jobs 输入处理与 gateway、AgentX Python 启动。可通过 OPENSSL_BIN 和 PYTHON_BIN 指定工具；缺失工具会明确记为跳过。该受控检查不替代真实 Docker、Ray、NPU 和模型验收。

## 插件种类

组件可选提供实时活动：Solver 通过 `AttemptContext.activity?.({ message, lines, activity })` 报告模型/工具活动；Environment 的 `materialize` 第四参数、`prepare` 第五参数和 `installRuntime` 第四参数提供相同回调。原 `onImageReady` 参数位置和语义不变；未实现回调的插件仍可运行。`ActivityListener`、`ComponentActivity` 从包根导出。

`Environment.materialize` 第五参数为可选的 `EnvironmentPreparationContext`：`{ taskId, phase: "solve" | "verify" }`，类型从包根导出。整批准备、流水线及 Ray 节点传入该参数，Docker 用它生成带任务和用途的镜像名称；直接 `prepare` 从 attempt 及阶段取得身份。外部环境可以忽略此参数，装饰或代理 `materialize` 时应转发全部参数。该上下文不写入任务数据，不改变 Solver 与 Verifier 的访问边界；未提供上下文时 Docker 使用 `shared` 名称。命名及缓存行为见 [Docker FAQ](../users/faq/docker.zh-CN.md#如何按任务区分和查看镜像)。

提供上下文时，Docker 会把固定摘要的外部任务镜像迁移到稳定的 Evaluator 标签，核对内容并保存本地来源记录后移除对应官方本地引用。插件应使用返回的准备凭据，不假定 Docker 中始终存在原官方引用。原来源仍保留在环境声明及结果中；固定 Node、可变标签和无上下文调用不执行此迁移，见上述 FAQ。

Benchmark 的 `resolveSource`、`enumerate` 第三参数及 `prepare`、`planRun` 第四参数同样接受可选 `ActivityListener`。来源适配器可报告实际下载字节、缓存校验和文件处理计数，规划可报告当前任务序号；不要把私有测试路径或内容传入回调。旧插件可继续省略这些参数。回调只报告实际处理活动，不用定时心跳模拟进展；步骤计时和结束状态由调用方维护。

独立插件可从包根复用 `DatasetCache`、`GitBlobCache`、`parseGitTree`、`writeGitFile`、`checkedPath` 和 `planBenchmarkRun`。`GitLfsCache` 处理标准 pointer/batch 协议，`GitHubLfsSource` 按 repository/revision/path 获取归档并校验指针文件的 Git SHA；`DockerImageArchiveLoader` 负责并发共享、取消、加载与候选标签重命名。插件只需提供来源参数及镜像映射，示例见 [DocOps 包](../../plugins/docops/README.md)。

需要为 Docker 构建准备外部基础镜像时，可向 `DockerEnvironment` 构造器传入 `prepareBuild(spec, signal, activity?)`。回调在任务镜像缓存未命中、构建快照校验通过后执行，`spec.build.context` 指向临时快照；只读取快照，不修改任务文件。回调完成后才构建任务镜像，失败或取消会终止构建，临时快照由环境清理。该选项仅用于插件代码，不是 YAML 字段；继承 DockerEnvironment 可以直接保留 materialize、installRuntime、prepare 和 recoverAttempts 等方法。使用准备凭证启动 attempt 时不会重新调用回调。

`lines` 只包含公开执行过程的命令或工具输出；不要发送模型思考、答案、隐藏测试或认证值。应在组件自身先脱敏，接收端还会做长度限制和脱敏。只有实际收到执行器输出、模型流或工具事件时才报告活动；仅提供能力说明时使用 `activity: false`。活动不改变评分，也不能代替原有结果和轨迹。Scheduler 可通过 `SchedulerContext.onProgress` 回传结构化进度，但不要序列化整个 context。

组件内部有独立子步骤时，可提供唯一的 `operationId` 和 `status`（`started`、`updated`、`completed`、`failed`、`cancelled`）。同一子步骤沿用 ID，结束后不能复用；核心将其放在调用方操作之下，并在父步骤结束时关闭尚未结束的子步骤。共享镜像构建向各等待者发布相同的组件操作 ID，各等待者的任务和 attempt 身份仍由核心补充。

Cordis 负责加载插件模块，模块通过 `ctx.evaluator.register()` 注册组件。一个模块可以注册多种组件，实验配置再按 `name` 选择使用哪一个。

记录型 Benchmark 的定义放在 `src/plugins/benchmarks/agent-harness/definitions/`：各题库文件负责题目转换和选择评分入口，`records.ts` 负责记录校验与任务构造，`prompts.ts` 保存题目提示词。评分实现放在同目录的 `scoring/` 中，按答案匹配、生成式选择题、概率评分、模型裁判和代码执行划分；DROP 这类复杂算法可单独保留。新增题库时优先使用已有评分机制，不要求每个题库都新增一个 `*-score.ts`。评分属于 Benchmark 的业务规则，不因文件名含 score 就改成独立 Verifier 插件。


| 种类            | 职责与接口                                                                | 内置实现                                                                   |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `benchmark`   | 数据来源、任务枚举与准备、验证；[Benchmark](../../src/core/contracts/benchmark.ts)         | GSM8K 等定义型 Benchmark、Harbor 协议执行 |
| `verifier` | 私有验证执行与原始奖励证据；[Verifier](../../src/core/contracts/verifier.ts) | `harbor-shell`、`harbor-python` |
| `environment` | 进程执行、文件传输和环境生命周期；[Environment](../../src/core/contracts/environment.ts)    | `local`、`docker`                                                       |
| `solver`      | 执行模型或 Agent 请求并返回结果；[Solver](../../src/core/contracts/solver.ts)          | `simpleagent`、`agentbundle`、`agentx-replay`、`choice-logprobs`          |
| `metrics`     | 从结果快照计算指标；[Metrics](../../src/core/contracts/metrics.ts)                   | `success-rate`、`duration`、`usage`、`harbor-score`、`quality-score`、`agentx-performance`    |
| `reporter`    | 将结果和指标渲染为报告；[Reporter](../../src/core/contracts/reporter.ts)               | `markdown`                                                             |
| `store`       | 保存 run、attempt、文件清单和结果快照；[RunStore](../../src/core/contracts/run-store.ts) | `local`                                                                |
| `scheduler`   | 安排任务准备、就绪队列和执行并发；[TaskScheduler](../../src/core/contracts/scheduler.ts)         | `local`、`ray`                                                          |

Reporter 可选实现 `taskReports(snapshot, metrics)`，返回 `{ id, taskId, title }` 列表，为单个任务生成独立报告。通用报告流程先筛选该任务的结果、历史 attempt 和准备记录，再重新计算所有指标，并向 `render` 传入可选的 `ReportContext`；其中 `evidenceRoot` 是报告到 run 根目录的相对路径，用于生成可打开的证据链接。声明独立报告时，根 `render` 应输出目录页。Store 需要实现 `saveReportBundle`，同时保存目录和 `points/<id>/report.md`、`metrics.json`，并检查 snapshot、版本和安全路径；Store 必须实现 `saveReportBundle`，单报告时接收空的文档数组；不再提供旧的 `RunStore.saveReport` 方法。Reporter 的 `render` 同时用于单报告和各任务报告。相关类型从包根导出。




`runtime.phaseTimeouts` 携带 YAML 的可选解题、评分覆盖值，不注入阶段默认值。Benchmark 应先校验任务声明，再用覆盖值决定 `PreparedTask.phaseTimeoutSeconds`；验证器有内部计时器时，其描述也必须使用同一个最终时限。`VerificationTask.timeoutSeconds` 缺省时，不创建验证阶段计时器，只响应调用方传入的 signal；核心仍执行整题上限。Harbor 内置实现和 Ray 准备、执行均遵循这一规则。

镜像清理使用可选能力：`Environment.cleanupImages(request, signal)` 返回当前 Docker 的处理结果；远端 Scheduler 实现 `cleanupImages(request, environment, pluginVersions, signal)`，在目标节点调用环境能力。`ImageCleanupRequest`、`ImageCleanupNode`、`ImageCleanupSummary` 从包根导出。`execute: false` 只预览；不得删除镜像或变更任务关联。`acquireImageLease(signal)` 返回异步释放函数，框架在准备和运行期间使用它阻止并发清理。未实现能力的组件明确返回不支持，框架不会调用 Solver 或根据插件名猜测删除方式。

内置 Docker 按 `runtime.imageConfigFingerprint` 和准备上下文的任务、阶段记录镜像关联；指纹排除服务认证、输出路径、调度参数及插件声明的节点本地字段，保留题目选择。独立的第三方镜像获取代码需要自行接入归属记录，不能把预先存在的来源引用视为可删除资源。Ray 部署须持久化节点的 `EVALUATOR_CACHE_DIR`。

Benchmark 实现 `planRun()` 时，Scheduler 需要实现 `prepareTasks(jobs, plan, context, signal)`。本地 Scheduler 在这里选择整批等待或有界流水线；单题准备调用框架提供的 `context.prepareTask(task, signal, { roundId, timing })`，不要重复获取 Solver runtime、合并 requirements 或准备验证器依赖。整批模式返回 `{ tasks }`，流水线返回 `{ pipeline }`；流水线必须提供可取消的任务源、`completion` 和 `cancel()`，提前关闭后等待已开始的准备退出。所有 Scheduler 必须实现 `executeReady(jobs, executor, signal)`，它负责执行槽位和动态补测任务；任务源是可取消的异步流，整批就绪任务也通过同一入口派发。

`PreparationContext`、`ScheduledPreparation` 等类型以及 `createPreparationRound`、`runPreparationRound` 从包根导出。前者创建公共准备记录并校验预算，后者在 Scheduler 提供的整批工作外设置绝对预算并保存结果。`context.settings` 可能省略，此时由 Scheduler 选择默认值；内置 Local 默认 pipeline，准备并发等于自身执行并发，Ray 默认 batch。配置解析会为显式声明的 preparation 补齐 mode 和 concurrency，外部 Scheduler 的缺省模式仍为 batch。Scheduler 公共契约不再包含数组版 `execute()` 或 `prepareRun()`；带 `planRun()` 的 Benchmark 需要 `prepareTasks()`；没有运行计划的 Benchmark 仍可使用原来的 attempt 内准备。Ray 节点调用公共单题准备函数，协调端只安排节点和检查回执，不能在协调端调用本地环境准备回调。

远端 Scheduler 支持独立 `warmup` 时，还需实现 `setupPreparation(context, signal)`。`SchedulerPreparationContext` 提供来源、配置摘要、插件/包版本和 Solver 元数据，以及进度回调；没有评测 Store。此入口只初始化节点连接和准备控制通道，不能创建评测 Run、分配 Attempt 或启用评测结果上传。正式评测仍调用 `setup(SchedulerContext, signal)`。两个入口应复用连接和节点分配代码。`prepareTasks()` 可返回 `placements: { taskId, nodeId }[]`，包括已分配但准备失败的题，供预热摘要显示；执行必须使用已经准备的节点。资源通过插件生命周期释放，取消后等待节点准备工作退出。

Store 或 Scheduler 生成的 `AttemptRecord` 必须包含 `evaluationKind`、`executionStatus`、`scoreStatus` 和 `cleanupStatus`；当前类型不再接受 `status`、`timeoutKind`。指标插件直接读取这些字段；需要报告中的状态文字时可从包根导入 `attemptStatus()`、`attemptTimeoutKind()`，不要把显示值再写入记录。历史结果仅在本地 Store 的读取入口转换，新的提交和远端消息必须使用当前结构，字段组合规则见[结果与错误说明](../users/reference/errors.zh-CN.md)。

## 编写插件

Solver 的 `runtimeInstallation()` 返回 `RuntimeInstallation` 时，可以设置 `cacheName`，例如 `agentx-1.0.7-py3.12`。本机托管目录为 `<缓存根目录>/<cacheName>/<12 位内容哈希>`；未设置时名称为 `runtime`。名称为 1～48 个小写 ASCII 字母、数字、点或连字符，首尾必须是字母或数字，不接受 Windows 设备保留名称。名称仅用于本机缓存目录，不参与内容摘要；完整摘要仍根据 `id`、平台、文件及命令计算，Docker 镜像身份不受名称影响。安装直接在最终目录执行，因此命令可以保存 `{root}` 的绝对路径。缓存位置及清理方法见[安装指南](../users/installation.zh-CN.md#本机运行时缓存与-windows-路径长度)。

编写或修改 Benchmark 插件时，接口、代码职责、生命周期及受控示例见 [Benchmark 开发指南](benchmarks.md)。数据集的官方要求、镜像、平台、资源、超时配置和真实运行验收见 [Benchmark 评测要求与验收指南](benchmark-evaluation-requirements.md)。

下面以“已完成任务数”指标为例，新建 `experiments/plugins/completed-count.mjs`：

```js
export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.evaluator.register(
    "metrics",
    "completed-count",
    (config) => {
      if (
        config === null || typeof config !== "object" ||
        Array.isArray(config) || Object.keys(config).length > 0
      ) {
        throw new TypeError("completed-count 不接受配置参数");
      }
      return {};
    },
    () => ({
      name: "completed-count",
      async compute(snapshot) {
        return {
          completed: snapshot.records.filter(
            (record) => record.executionStatus === "completed",
          ).length,
        };
      },
    }),
  );
}
```

`register(role, name, validate, factory)` 的四个参数分别是组件种类、注册名、配置校验函数和实例工厂。工厂可以接收 `(config, runtime)`，其中 runtime 提供模型配置、运行时认证和 `resolvePath()` 等上下文；认证只用于调用模型，不写入日志或结果。

执行组件的 `runtime.hardware` 为实验选择的 `npu` 或 `gpu`，bootstrap 和 Ray worker 都传入实际值。历史 SDK 调用方省略该字段时按 NPU 处理。需要加速卡的插件应按该值选择实现，并在分配资源前拒绝不支持的硬件；不需要加速卡的插件无需检测设备。Metrics/Reporter 继续只使用报告上下文，离线报告不探测硬件。

使用 TypeScript 开发时，可从 `ember-evaluator` 包根导入 `HardwareKind`、`Metrics`、`Benchmark`、`Solver`、`PluginFactoryContext` 等公共类型，并实现对应契约。加载前需要编译为 JavaScript，CLI 不直接加载 `.ts` 入口。

## 仓库内插件与 `ember-plugin.json`

`plugins/<id>/` 下的插件要想进入构建产物，必须提供 `plugins/<id>/ember-plugin.json`。`pnpm build` 扫描该目录后依次校验清单、按清单构建（`tsc` 类型检查，可选再执行插件自带的打包脚本），再把声明的文件复制到 `dist/plugins/<id>/`。没有清单的目录不编译、不复制，只能在源码中直接 import。

构建方式有两种：

- **只做类型检查 + `tsc` 输出**：只声明 `build.tsconfig`，适用于代码直接编译为 ESM 的插件。
- **自定义打包脚本**：声明 `build.script`，由插件自己的脚本产出 `dist/`，适用于需要 esbuild 打包、生成资源哈希或复制静态资源的插件（如 aisbench、docops）。两种方式可以叠加，先执行 `tsc` 校验，再执行脚本。

只通过 `--patch` 加载的插件声明 `patch`，让构建把补丁文件一并安装到 `dist/plugins/<id>/`。以 [`plugins/aisbench/ember-plugin.json`](../../plugins/aisbench/ember-plugin.json) 为例：

```json
{
  "id": "aisbench",
  "description": "AISBench benchmark with an SSH solver for remote accelerator evaluation",
  "entry": "./dist/index.js",
  "bundled": true,
  "patch": "cordis.patch.yaml",
  "build": { "tsconfig": "tsconfig.json", "script": "scripts/build.mjs", "install": ["dist"] }
}
```

加载方式：

```bash
ember-evaluator run experiment.yaml --patch dist/plugins/aisbench/cordis.patch.yaml
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 必须与目录名一致，同时决定 `dist/plugins/<id>/` 的位置 |
| `description` | 否 | 插件说明 |
| `version` | 否 | 省略时继承根 `package.json` 的版本，避免两处维护 |
| `entry` | 否 | 插件模块入口，指向编译后的 JS；也用于 `--patch` 中指向自身的入口 |
| `bundled` | 否 | `true` 表示随宿主发布的内置插件 |
| `patch` | 否 | 指向插件目录下的 `cordis.patch.yaml`；构建时复制到 `dist/plugins/<id>/`，并把其中 `./dist/` 前缀改写为 `./` |
| `build.tsconfig` | 有 `build` 且无 `build.script` 时必填 | 插件自己的 tsconfig，用于类型检查（`noEmit`）或输出到 `dist` |
| `build.script` | 有 `build` 且无 `build.tsconfig` 时必填 | 插件自带的 Node 打包脚本，以插件目录为工作目录执行，负责产出 `dist/` |
| `build.install` | 有 `build` 时必填 | 要放进运行时的路径；`dist` 的内容平铺到 `dist/plugins/<id>/`，其他路径保留相对位置 |

构建产物：

```text
dist/plugins/
├── aisbench/
│   ├── ember-plugin.json  # 原样复制，便于运行时追溯来源
│   ├── cordis.patch.yaml  # 由清单的 patch 复制，./dist/ 前缀已改写为 ./
│   ├── index.js
│   ├── profiles/...
│   └── runtime/...
└── docops/
    ├── ember-plugin.json
    ├── cordis.patch.yaml
    └── index.js
```

清单中的 `entry` 是相对插件目录的编译产物路径（如 `./dist/index.js`），安装后位于 `dist/plugins/<id>/` 下。

## 用 `--patch` 引用外部插件

在独立目录新建 `cordis.patch.yaml`：

```yaml
- insert:
    - id: custom-metrics                    # 插件模块的唯一标识，用于来源与版本记录
      name: ./completed-count.mjs            # 模块路径，相对本 patch 文件所在目录
      # name 也可填已安装的 npm 包名；npm 包从 patch 文件目录解析。
      # 当前 patch 仅支持 insert，条目只接受 id 和 name。
```

目录结构如下：

```text
experiments/
├── gsm8k.yaml
└── plugins/
    ├── cordis.patch.yaml
    └── completed-count.mjs
```

随后将 `gsm8k.yaml` 的 `metrics` 改为：

```yaml
metrics:                       # 显式列表会替换默认指标，需保留的内置指标也要列出
  - name: success-rate
  - name: duration
  - name: usage
  - name: completed-count      # register() 声明的组件名，不是 patch 的 id 或模块路径
    # config: {}               # 组件参数写在这里；本示例插件不接受非空参数
```

运行时显式指定 patch；省略 `--patch` 时只加载内置组件：

```bash
ember-evaluator run experiments/gsm8k.yaml --patch <path>/plugins/cordis.patch.yaml
```

`--dry-run` 也接受相同的 `--patch <path>` 参数。patch 路径相对当前工作目录解析；patch 内的本地模块和 npm 依赖相对 patch 文件目录解析。实验配置中的 `cacheDir`、输出目录等仍相对实验 YAML 所在目录解析。

更多安装与构建说明见 [DocOps package README](../../plugins/docops/README.md)。

Ray 节点不会接收协调端的本机 patch 路径或源码。使用外部插件时，先将 patch 和模块安装到每个执行节点；在各节点 EVALUATOR_NODE_CONFIG 指向的 JSON 中设置 pluginPatchPath，该相对路径以节点配置文件所在目录为基准。所有节点的 patch 内容必须一致，worker 会在执行前校验 patch 与插件版本摘要。

Ray Jobs 部署还需在协调端容器设置 EVALUATOR_PLUGIN_PATCH_PATH，指向容器内已安装的同一 patch 文件；相对路径以 Jobs 进程工作目录解析，建议使用绝对路径。worker 节点仍需在自己的 Node 配置中设置 pluginPatchPath。这样提交命令的 --patch、Jobs 协调端和执行节点会加载同一插件版本。

### 组件配置传到 Ray 节点

`register(role, name, validate, factory, transport?)` 的第五个参数声明配置的传输规则，类型 `PluginConfigTransport` 从包根导出。无需修改 Ray 内的组件名称列表。例如：

```ts
ctx.evaluator.register("benchmark", "my-records", validateConfig, createBenchmark, {
  nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" },
  containerPaths: [["defaults", "workdir"], ["taskProfiles", "*", "extraPaths", "*"]],
  validate(config) {
    // 只检查配置；不要下载、创建容器或请求模型。
    if (config.sourceKind === "local") throw new TypeError("Local input cannot be distributed");
  },
});
```

- `nodeLocal` 只声明顶层字段。发送端删除这些字段；接收端把 `cache` 设置为 `<outputRoot>/cache/<role>/<name>`，把 `docker` 设置为节点配置中的 `dockerExecutable`。节点未指定 Docker 路径时省略字段，由组件自己的校验器提供默认值。
- `secretFields` 声明不允许发送的顶层凭据字段，例如 `["hfToken"]`。投递及 Jobs 重试配置删除这些字段，接收端拒绝任务中携带这些字段；组件在节点上自行读取本地凭据。使用 `${NAME}` 配置敏感字段时，保存和导出的本地配置保留完整变量引用，不保存展开值。
- `containerPaths` 声明容器内绝对路径的精确位置，`*` 匹配一层对象键或数组下标。路径必须是规范 POSIX 绝对路径，不允许 Windows 路径、双斜杠或 `..`；相邻字段和更深的子字段不会自动放行。
- `validate` 是可选的纯检查，检查删除节点字段后的配置，接收端也会执行。Harbor 在自己的声明中拒绝本地数据来源，并声明工作目录字段。
- 声明由各端已安装的插件提供，不接受请求携带的声明。未声明的绝对路径、`cacheDir` / `dockerExecutable`、认证字段和带认证的 URL 仍会被拒绝。相对的预装资源路径仍相对接收端实验目录解析，不会自动上传。
- 直接 Ray、Ray Jobs 提交、Jobs 协调端和 worker 使用相同规则。本地调度不执行这些转换。声明只解决配置传输，不代表组件自动支持远端执行；来源、私有材料和 runtime 仍须满足现有契约。

## 验证器运行环境

需要额外 Python 进程或容器的 Benchmark 可实现 `verificationRuntime: VerificationRuntime`，类型从包根导出。它与任务本身的 `solveEnv` / `verifyEnv` 分开：例如 WorkBuddy 的 Python 辅助进程通过 RPC 检查任务容器，不能替换任务容器。纯函数评分和直接在任务环境执行的 Shell verifier 无需声明。

- `materialize(task, signal, activity?)` 准备共享依赖，返回 JSON 回执，不创建 attempt 容器。批量、流水线和 Ray 节点在发布 ready 之前调用；无 `planRun` 时在求解前调用。回执写入 `PreparedTask.verificationRuntime`，不会传给 Solver。不要在进度中输出私有测试内容。
- `prepare(task, receipt, { key, paths, signal, activity? })` 使用回执创建本次验证资源，返回 `VerificationRuntimeSession`。这里禁止重新构建或下载镜像；准备失败时应释放已分配资源，无法确认释放时抛出带 `CLEANUP_FAILED` 的错误。
- 句柄的 `verify(result, environment, signal)` 返回 `VerifyResult`；有运行句柄时框架调用该方法，否则调用原来的 `Benchmark.verify`。`environment` 是按原共享/独立规则选择的任务验证环境，允许为 null。`metadata` 保存到 `result.json` 的 `environments.verificationRuntime`，只能包含可持久化的运行信息。
- 框架在成功、失败、取消及准备句柄迟到时调用 `dispose`，使用独立的清理信号。清理异常写入 attempt，不能吞掉异常后报告清理成功。需要续跑回收的组件同时提供 `recoverAttempts(keys, signal)`，仅回收指定 attempt 的资源。

可组合的 Verifier 使用 `runtime: VerificationRuntime<JsonValue, VerificationEvidence>`，接收它自己的私有描述。Harbor 将其接入上述流程，并继续用原评分配置处理返回的奖励。内置 `harbor-python` 与 HumanEval 已使用该生命周期；其容器按 attempt 打标签，并通过不可变镜像 ID 创建，执行阶段禁止自动 pull。

插件工厂通过 `runtime.services` 与明确的服务名获取模型及认证。Solver 使用 `bindSolverService(runtime)`；Verifier 使用 `bindService(runtime, runtime.verifierService)`，仅在已配置该路由时访问。两个函数从包根导入。工厂上下文不提供顶层 `model`／`auth`；不要把 Solver 服务当作 Verifier 的默认服务。Ray worker 只接受 `{ services }`，Ray Jobs 只接收 `serviceAuth`，不再接受单模型旧格式。
