# 渐进式实验配置

> [English](./config.md) | 中文

实验 YAML 可以只声明模型服务和 Benchmark，框架通过插件 Profile 补齐其余参数：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark:
  name: workbuddy
  scenario: office
```

直接使用 [Office 示例](../../playbook/workbuddy/workbuddy-office.yaml) 或 [DeepSWE 示例](../../playbook/deepswe/deepswe.yaml)。DeepSWE 默认版本为 1.1；WorkBuddy 默认 code，支持 code、office、web、security。来源固定到现有 Git revision 或归档摘要，未知版本和场景会报错。

正式 YAML 见 [Playbook 导航](../../playbook/README.md)，各任务的版本、评分和执行条件见 [Benchmark 指南](benchmarks/README.zh-CN.md)。

Terminal-Bench 与 SWE-bench Verified 分别可用 `benchmark.name: terminalbench/swebench`，默认版本为 2.0/1.0；GSM8K、HumanEval、MMLU 也由 Profile 提供默认缓存配置。模型预算、选题、独立裁判和自定义 Solver 仍由实验 YAML 显式指定。Ray 示例只需设置 scheduler.name: ray 和并发数；未指定连接地址时，正式运行会准备并使用仓库配套本机 Ray 集群。

Terminal-Bench 的版本、任务镜像与支持条件见 [Terminal-Bench 指南](benchmarks/terminalbench.zh-CN.md)。

![YAML 经 Profile 展开和配置校验，由 bootstrap 调用 Cordis 注册的工厂创建组件](imgs/02-framework-config-plugins.png)

`loadConfig` 使用已注册的 Profile 补齐配置，`bootstrap` 再按组件名称调用工厂。模型认证按 service 绑定，保存配置时只保留认证引用。组件注册和参数校验不会启动任务。

## 配置名称与默认值

| 名称 | 你要决定什么 | 例子 |
| --- | --- | --- |
| Benchmark | 测什么题或什么负载 | `gsm8k`、`workbuddy`、`agentx` |
| Solver | 由谁执行任务 | `simpleagent`、`agentbundle`、`agentx-replay` |
| services | 模型叫什么、请求发到哪里、用哪个认证变量 | `services.default`、`services.judge` |
| environment | Agent 在哪里运行 | 当前机器的 `local`，或隔离的 `docker` |
| scheduler | 同时跑多少任务、是否使用 Ray 节点 | `local`、`ray` |

Benchmark 的 Profile 是一组默认配置。例如选 `workbuddy` 的 `office` 场景后，会自动带上对应数据来源、验证器和默认预算。先使用默认组合，有需要再改；用 `inspect` 查看最终用了什么。

Environment 默认 Docker，Scheduler 默认 Local 并发 1，Store 默认 Local，Reporter 默认 Markdown。省略 `output` 或 `output.directory` 时，结果保存在仓库根目录的 `results/<Benchmark 名>/<YAML 文件名（不含扩展名）>/<runId>/`。例如 `playbook/gsm8k/gsm8k-agentbundle.yaml` 对应 `results/gsm8k/gsm8k-agentbundle/<runId>/`；Benchmark 名使用配置中的名称，WorkBuddy 的各场景均归入 `workbuddy`。默认路径不受 YAML 所在目录或命令启动目录影响；安装包运行时，以 Evaluator 包根目录代替源码仓库根目录。

显式填写 `output.directory` 可以覆盖默认位置；此时相对路径仍相对实验 YAML。已有运行需要续跑时，应保留原来的输出目录配置；`inspect` 输出和运行保存的配置会记录实际输出目录。Harbor 缓存默认使用系统用户缓存目录，可通过 EVALUATOR_CACHE_DIR 或 benchmark.config.cacheDir 覆盖；Security 必须使用 Linux 原生目录，不能解压到 Windows 或 /mnt/c、/mnt/d。

本地默认使用环境准备流水线，准备并发跟随 `scheduler.concurrency`；每题求解和验证依赖都就绪后，有空闲执行位置即可开始解题。需要等整批准备完再执行时，设置 `run.preparation.mode: batch`；需要单独限制准备并发时，设置 `run.preparation.concurrency`。Ray 保留整批模式，AgentX Profile 保留串行整批准备。规则及示例见[并发与环境准备](concurrency.zh-CN.md)。

组件支持字符串简写，例如 `reporter: markdown`、`metrics: [harbor-score, success-rate, duration, usage]`，以及 `{ name, config }` 完整写法。Environment 的 platform 与 Scheduler 的 concurrency、nodes 支持平铺；与 config 重复提供同一参数会报错。更换插件名称会清除上一实现的专属配置。

默认运行全部任务，单题失败后继续其他题（`onError: continue`）。使用 `run experiment.yaml --resume [run-id]` 续跑；配置使用 `services` 与单个 `benchmark`，不接受旧 `benchmarks` 数组或顶层 `model`、`solver`。

## NPU 与 GPU 选择

在实验 YAML 顶层设置 `hardware`，作用于整个实验：

```yaml
hardware: npu # npu 或 gpu；省略时默认 npu
```

用户 YAML 覆盖 Profile 默认值，未指定时使用 NPU。`inspect` 和保存的运行配置记录实际选择，Ray 节点接收同一值。该字段不探测本机设备，不启动或切换远端模型服务，也不将 CUDA 题目转换为 NPU 题目。无需加速卡的任务在两种选择下行为相同。

| 场景 | `npu` | `gpu` |
| --- | --- | --- |
| AgentX API 回放、vLLM 指标 | 支持 | 支持 |
| AgentX `telemetry.ascend` | 使用 Ascend 采集 | 配置冲突，运行前报错 |
| Kernel 精度、计时与 profiling | 使用 NPU | 运行前报 GPU 后端尚未实现 |
| Harbor 题目明确要求 GPU | 报题目与所选硬件不匹配 | 报 GPU 任务执行尚未实现 |

普通模型 API 调用不要求 Evaluator 所在机器有 GPU/NPU。GPU 硬件采集和任务设备挂载当前不支持。硬件不匹配的题目记录为失败，后续处理遵循 `run.onError`，不会静默跳过或替换硬件。

旧配置省略该字段仍按 NPU 读取；缺省与显式 `npu` 的续跑配置指纹相同，改为 `gpu` 后需要新建 run。源码、插件版本和数据来源变化仍受原有续跑检查约束。离线 `report` 不访问硬件。

## 按需增加参数

```yaml
benchmark:
  name: deepswe
  version: "1.1"
  solver:
    name: agentbundle
    # service: default
    config:
      path: ./bundles/dsh-deepswe

environment:
  platform: linux/amd64

scheduler:
  concurrency: 8

run:
  taskIds:
    - fastapi-deprecation-response-headers
  timeoutSeconds: 18000

output:
  directory: ./results/my-experiment
```

上面的片段与 services 一起使用。Solver 缺省为 simpleagent；AgentBundle 是 Solver 插件，path 必须指向已准备好的 Bundle。服务优先选择 services.default，其次选择唯一服务；多个服务且没有 default 时必须明确指定 solver.service。模型协议缺省为 openai-completions，模型预算由 Harness 和模型服务管理。

### 整题与阶段超时

```yaml
run:
  timeoutSeconds: 7200        # 整题上限，单位秒
  solveTimeoutSeconds: 3600   # 可选：解题阶段上限
  verifyTimeoutSeconds: 600   # 可选：评分阶段上限
```

`run.timeoutSeconds` 保留为单个 attempt 的整题上限。框架默认值为 7200 秒（2 小时）；所选 Profile 或 YAML 显式提供的整题值仍优先于框架默认值，已有示例的显式值不会自动改写。

解题和评分分别选择自己的时限：显式 `run.solveTimeoutSeconds` / `run.verifyTimeoutSeconds` 优先，其次采用任务 `agent.timeout_sec` / `verifier.timeout_sec`。对应两处均未设置时，不额外创建该阶段的时限，只遵循整题上限。两个新字段均为可选正整数；省略表示不覆盖任务声明，`0`、`null` 和负数不是关闭时限的方法。

整题时钟与阶段时钟同时生效，先到期的限制终止执行；阶段时限从进入对应阶段开始，设置更长的阶段值不会延长整题上限。提前环境准备与清理使用各自时限，详见下文。

旧字段 `benchmark.config.defaults.verifyTimeoutSeconds` 已删除，改用 `run.verifyTimeoutSeconds`，不自动兼容或迁移。更新 Ray 部署时，coordinator、worker 和 Jobs 运行包需要一起更新，确保阶段参数传递一致。

下载源、代理及镜像获取方式使用独立的 [网络 YAML](network.zh-CN.md)，由 `--network` 指定。

Pi / SimpleAgent 和内置 Judge 对显式 `base_url` 的 OpenAI Chat Completions 服务遵循同一输出规则：配置 `services.<服务>.maxTokens` 时发送该上限；省略时不发送 `max_tokens` 或 `max_completion_tokens`，由 API 服务决定回复上限。SDK 必需的模型预算仍用于本地上下文管理，不构成隐含的请求输出限制。通过已注册 Provider 使用模型时保留其 SDK 协议默认值；其他外部 Agent 保留各自的模型配置机制。

Pi 的本地模型预算依次使用显式 `maxTokens`、随包发布的 [模型默认配置](../../src/runtimes/pi/model-defaults.json)、已注册模型参数，最后为 `128000`。默认配置支持模型 ID 或 `provider/模型 ID`，后者优先；配置参与运行时内容摘要。服务端仍可能因自身回复或上下文限制截断；Evaluator 会保留真实终止原因，不将截断回复当作合法评分。

### 环境准备时限

```yaml
run:
  preparation:
    concurrency: 8
    environmentTimeoutSeconds: 600 # 可选：并发为 1 时的单环境基础时限
    # roundTimeoutSeconds: 7200    # 可选：整轮上限，不乘并发
```

单任务的求解环境和验证环境分别从实际准备开始计时，实际时限为 `基础时限 × min(有效准备并发, 10)`。排队、就绪后等待执行不计入。Local 的有效并发取准备并发与待准备任务数的较小值；Ray 再受所在节点槽位数限制，不使用集群总并发。系数在本轮分配完成后固定，尾部任务不缩短时限。

基础时限优先取显式 `run.preparation.environmentTimeoutSeconds`，其次取任务对应环境声明，再取 Benchmark 缺省值。Harbor 保留求解、独立验证环境各自的 `build_timeout_sec`，缺省为 `defaults.buildTimeoutSeconds`；记录型题库缺省为 600 秒，OfficeQA Pro V2 和 AgentX 为 3600 秒。验证镜像与 verifier runtime 准备共享验证阶段时限；没有独立镜像但需要 verifier runtime 时，也执行验证准备限时。两个新配置均为有限正数秒数，缺省不写入配置，最终毫秒值不能超过 Node timer 范围。

默认没有整轮准备上限。显式设置 `roundTimeoutSeconds` 时，Local batch 与 Ray 按整轮墙钟计时；Local pipeline 只统计有准备工作进行的时间，仅等待执行时暂停，网络和构建等待仍计时。该上限不乘并发。没有 `planRun()` 的外部插件不创建准备轮次，其 attempt 内准备仍受整题时限约束；单环境准备阶段采用相同倍率，并累计对应阶段的准备忙时间。

准备超时记为 `ENV_PREPARATION_TIMEOUT`，不产生评分，也不自动重试；`onError: continue` 时允许其他正常任务继续，清理或存储故障仍可能要求停止。基础值 600 秒、有效并发 32 时，单环境最多等待 6000 秒；基础值 1800 秒则为 18000 秒。需要缩短等待时降低基础值，或显式设置整轮上限。

旧 Harbor 字段 `benchmark.config.environmentBuildTimeoutMultiplier` 已删除，不能继续叠乘。旧配置需移除该字段；若需要整轮限制，改为显式 `roundTimeoutSeconds`，若需要调整单环境基础值，使用 `environmentTimeoutSeconds`。Profile 展开后的配置身份检查仍然生效；升级后配置无法匹配原 run 时新建 run，或使用原配置完成续跑，不修改旧 manifest。Evaluator 代码允许更新并重新构建后续跑。历史整批预算按原含义保留，离线报告不把它当成单环境时限。

## 指定起始题目与题数

`run.offset` 表示跳过前多少道题，必须是非负安全整数；省略或设为 `0` 时从第一题开始。`run.maxTasks` 表示本次最多运行多少道题，必须是正整数；省略或设为 `null` 时运行剩余全部题目。例如，从第 11 题开始运行 5 道题（第 11～15 题）：

```yaml
run:
  offset: 10
  maxTasks: 5
```

默认按 Benchmark 枚举顺序选题。同时设置 `run.taskIds` 时先筛选候选题目，仍保留来源顺序；设置 `run.sampling: { strategy: random, seed: 42 }` 时再按固定种子打乱候选顺序。随后跳过 `offset` 道题，最后取最多 `maxTasks` 道题。要按原题库位置连续运行，请省略 `taskIds` 和 `sampling`。

剩余题目不足 `maxTasks` 时运行实际剩余题目；`offset` 大于或等于候选题数时会报选题为空。CLI 和 SDK 均支持 YAML 中的这两个参数，`--dry-run` 使用相同规则，可在正式运行前查看所选任务 ID。续跑需保持原来的 `offset` 和其他选题配置。CLI 的 `--task-ids-file` 会覆盖 YAML 选题，忽略 YAML 中的 `offset`、`maxTasks` 和 `sampling`。

## Hugging Face 受限数据认证

GPQA 使用受限仓库 [Idavidrein/gpqa](https://huggingface.co/datasets/Idavidrein/gpqa)，OfficeQA Pro V2 也需要访问授权。先用自己的 Hugging Face 账号接受数据集访问条件并获得权限，再创建具有该仓库读取权限的 [User Access Token](https://huggingface.co/settings/tokens)。Token 不会替代数据集访问审批，模型 API key 也不能用作 HF_TOKEN。

在 YAML 中像模型 key 一样直接引用环境变量，SDK 的 `env` 也可提供此值。以 GPQA 为例，完整配置见 [GPQA 全量配置](../../playbook/gpqa/gpqa-simpleagent.yaml)：

```yaml
benchmark:
  name: gpqa
  config:
    hfToken: ${HF_TOKEN}
```

10 个 HF 记录型题库（gsm8k、mmlu、mmlu_pro、math500、gpqa、mgsm、triviaqa、humaneval、simpleqa、healthbench）、OfficeQA Pro V2 和 AgentX 均支持 `benchmark.config.hfToken`。DROP 直接下载 AllenAI 官方原始数据包，不使用 hfToken，配置仅支持 cacheDir。旧 `hfTokenEnv` 字段不再接受。公开数据可省略 hfToken，避免引入不必要的必填环境变量；GPQA 和 OfficeQA 示例显式声明认证。

AgentX 的 Trace 数据集公开，原有示例不需要额外设置 HF_TOKEN。tokenizer 由用户随推理服务准备，按现有 tokenizer 字段提供相应模型的本机目录，不增加 tokenizer 认证参数。WorkBuddy 的现有公开归档不要求 HF token。

配置保存和导出只保留变量引用，不保存展开值。Ray 消息及 Jobs 重试文件删除显式凭据字段，执行节点使用自身固定名称的 HF_TOKEN；未显式配置 hfToken 时也可从该变量读取。不自动读取 `hf auth login` 的本地缓存。WSL 中可以交互输入，避免把值写入命令历史：

```bash
read -rsp 'HF token: ' HF_TOKEN
printf '\n'
export HF_TOKEN
```

也可将只有 token 的 UTF-8 文本文件放在 Windows，再在 WSL 中读取，例如 `export HF_TOKEN="$(cat /mnt/c/Users/your-name/Desktop/hf_token.txt)"`。不要把 token 值写入 YAML、命令参数、聊天或结果。使用其他环境变量名时直接引用，例如 `hfToken: ${DATASET_TOKEN}`；Ray 节点仍需配置 HF_TOKEN。认证请求建议使用官方 `HF_ENDPOINT=https://huggingface.co`；镜像对 gated 数据的支持可能不同。权限要求见 [HF gated datasets](https://huggingface.co/docs/hub/datasets-gated)。

## 本机模型服务与 Docker

在原生 Linux Docker（包括 WSL 内独立启动的 daemon）中，宿主的 `127.0.0.1` 与容器的回环地址属于不同网络命名空间。框架将宿主回环模型地址映射到 `host.docker.internal`；该别名指向宿主网关，不会让只监听 `127.0.0.1` 的服务自动接受网桥连接。

本机运行 LiteLLM 等模型服务时，应提供 Docker 私有网桥可访问的监听地址，或增加只绑定该网桥的转发入口。需要同时保留宿主回环访问时，可继续监听回环地址并单独转发网桥连接。容器与服务的实际网络路径必须经过预检：使用实际 Solver 镜像、映射后的 endpoint 和相同 Harness 发起一次请求；仅在 CLI 所在宿主请求成功不足以证明容器可访问模型。连接失败且用量为零时，先检查监听地址、网关映射与代理绕过配置。

## 验证器与裁判模型

DeepSWE 和 Security 使用 shell 验证；Code 使用上游程序评分；Office 默认关闭可选模型评分。Office 如需开启，增加 services.judge 并设置 `benchmark.verifier: { service: judge }`。

Web 必须使用裁判模型，最简配置默认绑定默认服务。增加 services.judge 并设置同样的 verifier.service 即可独立选择裁判。验证器会接收所绑定服务的模型、地址和认证。高级实现可通过 benchmark.verifier.name/config 替换。

默认指标为 harbor-score、success-rate、duration、usage；DeepSWE 包含 f2p/p2p/partial 维度。deepswe-score 和 workbuddy-score 是 Profile 提供的配置别名，保存时展开为通用 harbor-score。

## 查看实际配置

```bash
ember-evaluator inspect experiment.yaml
ember-evaluator inspect experiment.yaml --patch ./patch.yaml
```

`inspect` 输出包含实际实验配置与网络设置的 JSON，保留密钥环境变量引用。它校验配置，不启动组件工厂、下载、任务枚举、容器或模型调用。模型设置从 YAML 读取；模型覆盖参数仅由 run 支持。

优先级为：框架默认、父 Profile、当前版本/场景 Profile、用户 YAML、CLI。对象递归合并，数组整体替换。来源信息不参与配置指纹；等价简写和完整配置可以得到同样的指纹。保存结果使用内部执行配置；离线报告与用户 YAML 有独立读取入口。续跑允许更新 Evaluator 代码，配置、来源、外部插件和 Solver 身份仍需匹配，详见[续跑说明](usage.zh-CN.md#续跑与重建报告)。

## Ray 与执行节点

![Ray 协调端派发任务，节点执行后通过 HTTPS 上传证据，接收端校验文件清单并导入 Store](imgs/07-flowchart-ray-execution-v2.png)

协调端的 patch 路径不会作为节点可访问的文件传过去。节点使用自己的预装插件和认证配置，并校验包、插件及 patch 摘要；结果通过上传回执确认，不依赖共享文件系统。

Ray 根据组件注册的传输声明处理配置，不按 Benchmark 名称区分。内置记录型题库和 Harbor 的 `cacheDir` 不会传给执行节点；节点按自己的 `outputRoot` 使用 `cache/<role>/<name>`，Jobs 协调端按 `EVALUATOR_JOBS_ROOT` 使用同样的目录结构。组件声明的 `dockerExecutable` 也由执行节点配置提供，未设置时使用组件默认值。本机运行仍使用实验中的原值。新增外部组件的声明方式见[插件开发说明](../development/plugins.md#组件配置传到-ray-节点)。容器工作目录仅在组件明确声明的位置允许传输，Harbor 本地数据来源仍不能直接分发。

使用配套本机 Ray 集群，只需增加：

```yaml
scheduler:
  name: ray
  concurrency: 4
```

未指定连接地址或 deployment 时，框架补齐本机 Ray Jobs 部署参数，正式运行会准备集群；查看配置不会启动集群。省略整个 scheduler 时仍使用 Local，不启动 Ray。

使用已部署的远端集群时，再填写连接参数：

```yaml
deployment:
  kind: ray-jobs
  endpoint: https://your-head:9443
  caFile: ./cluster-ca.pem
  tokenEnv: EVALUATOR_JOBS_TOKEN
  managedLocal: false
scheduler:
  name: ray
  concurrency: 25
  nodes: 2
```

run 在最外层根据 deployment 提交整实验；提交端不创建本地执行环境、Solver 或 Store。远端协调端读取内部执行配置并创建真正的 Ray TaskScheduler，不再次部署。CA、网关认证和 managedLocal 属于 deployment；nodes 和 concurrency 属于 scheduler。连接方式不根据 URL 协议隐式猜测。

显式填写 deployment 时，managedLocal 缺省 false，表示连接已有集群；设置 true 才会准备配套本机集群。省略 deployment 和 Ray Client endpoint 时，简写配置自动补齐 kind: ray-jobs、managedLocal: true。远端部署不会自动安装插件。nodes 选择已存在的节点，不负责部署或扩容。节点选择、准备、执行和清理沿用同一容量规则。

显式配置 scheduler.config.endpoint 且省略 deployment 时，由当前进程执行 Engine，通过 Ray Client 连接已有集群：

```yaml
scheduler:
  name: ray
  concurrency: 4
  config:
    endpoint: ray://your-head:10001
    collector:
      host: 0.0.0.0
      certFile: ./collector-cert.pem
      keyFile: ./collector-key.pem
      publicUrl: https://your-coordinator
      tokenEnv: EVALUATOR_TRANSFER_TOKEN
```

## 发现、初始化与诊断

benchmark list/info 从组件注册和 Profile 获取能力，不调用组件工厂。init --benchmark <name> --output <yaml> 生成新版最小配置，以 wx 写入，已有文件不会覆盖。benchmark list/info、init、inspect 和 doctor 都支持显式 --patch。

doctor <yaml> 复用正式配置和 Benchmark 组合校验，检查所需 Docker/Python、本地路径及 Ray 网络连接。会执行临时下载和 Docker 构建探针，不发送模型请求或执行任务。通过、失败和未检查分别显示为 passed、failed、not-checked；本地连通不等于远端节点环境或模型权限有效。发现失败返回 1，配置错误返回 2，取消返回 130。

--dry-run 会解析来源、检查缓存并按需下载，最终枚举所选任务 ID。与 doctor 的副作用范围不同。

## 记录型模型裁判

SimpleQA/HealthBench 通过 benchmark.config.judgeService 显式选择 services 中的独立服务。不自动复用被测模型；需要使用相同模型时也必须显式填写同一服务名。init 会生成默认的 judge 服务占位符。具体评分规则与自定义协议边界见[评分说明](reference/scoring.zh-CN.md)。

插件作者的 Profile 注册和发布方法见[开发指南](../development/benchmarks.md#发布默认-profile)。

## 网络故障补测

`ember-evaluator retry --run <run-id>` 为原 Run 的当前网络失败任务创建新 Attempt。有效零分、普通阶段超时和非网络错误不补测。网络访问仅在对应操作内有限重试，不自动补测整题；每次显式手动请求可为符合条件的任务追加一个 Attempt。`run.taskRetry` 已删除，旧 YAML 需要移除此字段。Ray Jobs 使用本页的独立 `deployment` 连接原网关，未注册为 Scheduler 插件。详见[网络故障补测](network-retry.zh-CN.md)。

[返回用户手册](README.zh-CN.md) · [快速上手](quick-start.zh-CN.md)
