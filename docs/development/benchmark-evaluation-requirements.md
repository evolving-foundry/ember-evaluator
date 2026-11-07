# Benchmark 评测要求与验收指南

> [English](./benchmark-evaluation-requirements.en.md) | 中文

本文面向负责接入数据集和验收实验的人员，回答“这个 Benchmark 要准备什么、怎么配置、怎样确认运行符合官方要求”。交付物是任务规格、实验 YAML 和真实运行的验收结果。

内容包括来源固定、官方镜像、平台要求、单任务资源与超时、公开和私有材料、产物交付、评分及验收。字段与限制以当前实现为准；示例预算用于说明配置位置，正式评测应采用官方要求并记录实测结果。

安装与依赖版本见[安装指南](../users/installation.zh-CN.md)，组件配置见[配置指南](../users/config.zh-CN.md)。现有组件无法表达任务要求、需要编写代码时，转到[Benchmark 开发指南](benchmarks.md)，其中维护接口、注册、生命周期和插件回归测试。

## 1. 选择接入方式

| 数据集情况 | 接入方式 | 需要完成的工作 |
| --- | --- | --- |
| 问答、选择题、文本生成等记录型题库 | 已有题库组件；缺少适配时交给插件开发 | 准备记录格式、题目与答案字段、split 和官方评分规则 |
| 已有 `instruction.md`、`task.toml`、环境声明及测试入口 | 通用 Harbor 配置；发布默认组合时增加 Profile | 固定来源、选择任务 ID、核对镜像与资源、配置奖励映射 |
| 需要特殊环境、状态交付或执行协议 | 交给插件开发，完成后按本文验收 | 列出已有组件不能满足的具体要求和预期行为 |

下载平台不决定接入方式。例如 Hugging Face 既能提供结构化记录，也能提供 Harbor 任务包。已有协议能够表达的能力直接使用配置。

只有涉及代码适配时才需要选择 Definition、Source 或完整协议实现；选择依据及实现方法见[Benchmark 开发指南](benchmarks.md#选择代码实现位置)。接入人员仍需提供下节规格，不能用“需要一个插件”替代明确的环境和评分要求。

## 2. 接入前填写任务规格

先确认官方要求，再填写实际接入值；两者不同必须说明原因。异构题库按任务或任务类别填写，不能用平均值替代单题要求。

| 项目 | 必须明确的内容 |
| --- | --- |
| 身份与范围 | Benchmark 版本、来源提交或归档摘要、split、任务 ID、任务总数与排除规则 |
| 公开输入 | Prompt、初始文件、公开工具、skills、MCP 或其他服务 |
| 私有材料 | 标准答案、隐藏测试、裁判规则和裁判凭据 |
| 镜像 | 是否有官方任务镜像、官方验证镜像；仓库、版本、digest、平台和拉取认证 |
| 平台 | 求解和验证分别要求的 OS/架构、是否允许模拟、原生依赖和系统要求 |
| 求解资源 | CPU、内存、临时存储，是否依赖 GPU/NPU；侧车服务的额外资源 |
| 验证资源 | shared/separate 模式、CPU、内存、存储及依赖；不能假定与求解相同 |
| 时间预算 | 环境准备、求解、验证、收集命令、单次 attempt 总时限 |
| 网络 | 来源下载、构建、求解和验证分别需要访问的服务与域名 |
| 交付 | 最终文本、文件、工作区归档、Git patch 或测量数据；路径与缺失处理 |
| 评分 | 主分数、正确性、错误哨兵、裁判配置、分母与无效结果处理 |
| 恢复与成本 | 来源变化检查、取消和释放、续跑、外部调用限流、token 与费用 |

把“官方要求”“节点可用资源”和“框架实际执行的限制”分开记录。例如 `storage: 16g` 当前只是声明，不能记为已经提供了 16 GiB 独立磁盘配额。

## 3. 固定数据来源与任务身份

- GitHub 来源固定到完整 40 位 commit，不使用会移动的分支或 tag 作为内容身份。
- HTTP 归档固定 URL、SHA-256 和归档根目录。认证信息不能嵌入 URL 或来源锁。
- 本地目录适合单机接入验证，Harbor 的 `source.kind: local` 当前不支持 Ray。分布式节点应能从固定来源独立物化数据。
- 任务 ID 必须唯一、稳定。记录顺序参与 ID 时，应固定文件、分区及转换顺序，并检查选题范围与实际执行题目一致。
- 来源锁保存版本和内容摘要；恢复时拒绝来源改变，不能沿用旧结果解释新题目。
- 检查题目数、split、重复记录、坏题和排除项。排除原因要可追溯，不静默跳题。
- 已有来源不支持数据格式时，向开发者提供原始样例、格式说明及内容固定方式。

Harbor 的归档、GitHub、local 具体写法见[来源配置](../users/benchmarks/harbor.zh-CN.md)。

## 4. 官方镜像优先于 Dockerfile

### 4.1 接入时的选择原则

先检查上游是否发布了与任务版本匹配的官方求解镜像、官方验证镜像及侧车镜像。存在可用官方镜像时，应在任务声明或明确的数据映射中填写镜像引用，优先使用该镜像；没有镜像声明时才使用受支持的 Dockerfile/Compose build 路径。

“官方镜像”是该 Benchmark 官方发布的对应任务环境，不是随便选择一个同语言基础镜像。记录其出处、任务版本、仓库、平台和 digest；正式评测优先固定 digest，避免 tag 移动。多平台 index digest 和单平台 manifest digest 要区分，所固定引用必须包含目标平台。

框架不自动搜索官方镜像，也不根据 Benchmark 名称猜测镜像标签。上游仅在非标准清单中发布镜像时，需要明确把该清单映射到任务环境字段，再验证映射关系。

### 4.2 当前 Harbor 的选择顺序

| 环境 | 优先级，从左到右 |
| --- | --- |
| 求解主容器 | `environment.docker_image` → Compose `main.image` → Compose `main.build` → `environment/Dockerfile` |
| 独立验证主容器 | `verifier.environment.docker_image` → 私有 Compose `main.image` → 私有 Compose `main.build` → `tests/Dockerfile`；无私有环境定义时回退复用求解环境定义 |
| 侧车服务 | 该服务的 `image` → 该服务的 `build` |

同一 Compose 服务同时声明 image 和 build 时选择 image。显式主镜像仅覆盖主容器，不删除侧车、依赖及健康检查。

Docker 节点先复用本地已存在且符合目标平台的声明镜像，缺少时拉取。这里的“优先拉取官方镜像”不表示每次运行都强制重新下载。镜像拉取失败、认证失败或目标平台不存在时保留真实错误，不自动改为 Dockerfile 构建。没有镜像声明才按上述构建路径处理。

使用官方任务镜像后，Evaluator 仍可能构建或安装自己的运行时层、Solver 层；这不等于重新构建任务 Dockerfile。共享准备结果按镜像身份检查，正式 attempt 不应重新选择来源或自动拉取另一个镜像。

### 4.3 镜像接入检查

- 求解和验证分别核对镜像，不能只检查求解镜像。
- 镜像支持任务要求的平台，包含任务入口所需 shell、系统库和运行依赖。
- 私有镜像的拉取认证在每个执行节点可用，不写入任务公开字段和结果。
- 求解镜像和公开构建上下文不含答案、隐藏测试或裁判凭据。
- 使用专属 Harbor Shell 验证镜像时，镜像内应包含 `/tests/test.sh`；框架不再上传测试覆盖它。共享及回退环境则在验证阶段上传测试。
- 验收无缓存拉取和已有缓存复用两条路径，并记录实际使用的镜像身份。

## 5. 明确平台与原生执行要求

### 5.1 声明任务平台

当前 Docker 环境支持 `linux/amd64` 与 `linux/arm64`；Harbor 的 `environment.os` 只支持 `linux`。Windows 容器、其他 OS 或其他架构不能视为已支持，须在接入前报告要求和阻碍。

Harbor 任务可声明：

```toml
[environment]
os = "linux"
platform = "linux/amd64"
```

独立验证环境默认继承任务平台，可以通过 `verifier.environment.platform` 显式声明自身要求；两阶段都要检查。

实验 YAML 可补充任务没有声明的平台，并禁止跨架构模拟：

```yaml
environment:
  name: docker
  platform: linux/amd64
  config:
    allowEmulation: false
```

实际选择顺序为：**任务的平台声明 → 实验 `environment.platform` → Docker daemon 原生平台**。实验平台不能覆盖题目已经声明的平台。`auto` 仅是 Docker 配置的自动选择值，不是任务的平台要求。

平台按实际执行节点的 Docker daemon 判断，不能只看启动 CLI 的 Windows、WSL 或协调端系统。Ray 的每个执行节点都需要满足要求。

### 5.2 跨架构和其他环境要求

当前默认允许探测并使用已有 QEMU；框架不会安装模拟器。跨架构模拟可能改变编译和计算耗时、触发额外超时，也不能作为原生性能成绩。正式耗时或吞吐比较建议使用目标架构原生节点，并设置 `allowEmulation: false`。

`linux/amd64` 或 `linux/arm64` 还不足以描述全部依赖。需要另外检查：发行版、glibc/musl、Python/Node/JDK、原生扩展、浏览器、指令集、内核能力、文件权限、大小写和符号链接，以及是否依赖 systemd、特权模式或 Docker socket。镜像可以拉取，不代表任务能正确执行。

这些附加要求不是都已有配置字段；需要逐项通过真实运行验收，缺少后端能力时明确报不支持。多容器任务还需 Compose v2；框架不会向 Solver 暴露 Docker socket。文件系统和架构故障处理见[FAQ](../users/faq/README.zh-CN.md)。

## 6. 单任务资源与并发

### 6.1 求解和验证分别声明

Harbor 任务的求解资源示例：

```toml
[environment]
cpus = 2
memory = "4g"
storage = "16g"
```

| 资源 | 当前执行能力 | 接入要求 |
| --- | --- | --- |
| CPU | Docker 设置 `--cpus`，设置并检查 cpuset 及 CPU 可见范围 | 是配额与亲和性限制，不保证独占物理核心；分数核配额与可见 CPU 数不应混为一谈 |
| 内存 | Docker 设置 `--memory` | 包含 Agent、工具、编译器、测试及其子进程开销；测量峰值 |
| 存储 | 保存声明，实际元数据为 `storage.enforced: false` | 不自动预留空间，不强制写盘限额；由部署容量与运行监控保障 |
| GPU/NPU | 当前没有完整的设备、显存和驱动配置支持；Harbor 拒绝 GPU 要求 | 不能仅填写 `gpus: 1` 运行，不能静默改用 CPU；GPU 与 Ascend NPU 均需先评估后端、调度及契约支持 |

Harbor 使用 `[environment]` 和 `[verifier.environment]` 的 `cpus`、`memory`/`memory_mb`、`storage`/`storage_mb`。同一段不能同时填写 `memory` 和 `memory_mb`，存储同理。建议使用 `4g`、`4096m` 等当前解析支持的单位格式。

独立验证默认继承 CPU、内存、存储和平台要求，可覆盖。shared 模式使用同一容器，不能额外声明一个独立验证环境来改变资源；需要不同环境或配额时选择 separate 并验收交付行为。

Docker 会对单个环境的 CPU、内存要求检查主机总容量；这不是所有并发任务的累计资源预留。Local 也不提供与 Docker 等价的资源和隔离保证。

### 6.2 容量按峰值估算

对规模相近、求解和验证按顺序执行且没有侧车的任务，可以先估算：

```text
CPU 并发上限 ≈ 可分配 CPU / max(单题求解 CPU, 单题验证 CPU)
内存并发上限 ≈ 可分配内存 / max(单题求解内存, 单题验证内存)
```

取较小值后还要给系统、协调进程、Docker 和并行准备预留余量。异构任务按实际组合计算，侧车单独计入，不能假设调度器自动为高资源题降低并发。镜像构建也有独立开销，运行容器的资源字段不等于构建阶段资源上限。

磁盘按峰值累计：数据及解压缓存、镜像层、构建缓存、所有活动工作区、产物打包、验证恢复副本和历史结果。不能简单用 `concurrency × storage` 作为节点全部磁盘预算。

Ray 当前每个执行任务申请 `1 CPU + 1 evaluator_slot`，不按每道题的 CPU、内存要求自动计算调度权重。部署时依据真实任务资源设置节点 slot 与实验并发，另设 `run.preparation.concurrency` 控制准备并发；详见[Ray 与执行节点](../users/config.zh-CN.md#ray-与执行节点)及[容量与使用限制](../users/concurrency.zh-CN.md#容量与使用限制)。

## 7. 时间预算与超时结果

### 7.1 分别设置各项预算

| 时间项 | 字段 | 当前含义和缺省 |
| --- | --- | --- |
| 单次 attempt 总时限 | 实验 `run.timeoutSeconds` | 每次 attempt 的执行预算，框架默认 7200 秒，Profile 可覆盖；不是整个实验的总时长 |
| 求解阶段 | `run.solveTimeoutSeconds`，其次 Harbor `[agent].timeout_sec` | 进入 solve 后计时；均未声明时没有额外阶段上限，仍受 attempt 总预算限制 |
| 验证阶段 | `run.verifyTimeoutSeconds`，其次 Harbor `[verifier].timeout_sec` | 进入 verify 后计时；均未声明时没有额外阶段上限，仍受 attempt 总预算限制 |
| 提前环境准备 | Harbor 各环境 `build_timeout_sec` 与 `run.preparation` | 按单环境基础时限乘 `min(本节点有效准备并发, 10)`；默认没有整轮上限 |
| 收集命令 | Harbor `[[verifier.collect]].timeout_sec` | 每条命令单独限时，默认 60 秒；也受调用阶段的外层预算限制 |
| 清理 | 无普通实验 YAML 配置项 | 框架另设受控清理预算，实际结束可能晚于 attempt 截止时间；必须检查清理状态 |

阶段截止时间和 attempt 截止时间谁先到，谁生效。预算需满足：

```text
attempt 总时限 >= 环境启动及 Solver 准备 + 求解 + 阶段切换
                 + 收集与传输 + 验证环境启动 + 验证 + 余量
```

例如求解上限 1800 秒、验证上限 300 秒时，可先给 attempt 2400 秒进行单题测量，再根据其他阶段耗时修正。不能把 attempt 也设为 1800 秒，并认为验证仍能获得完整 300 秒。

Shell verifier 的验证预算还覆盖验证方法内的测试上传、脚本执行和奖励读取，不只是 `test.sh` 的净执行时间。阶段外的验证容器启动和产物恢复也需要 attempt 余量。

### 7.2 Harbor 环境准备预算

求解和独立验证环境分别保留各自的构建声明，缺省使用 `benchmark.config.defaults.buildTimeoutSeconds`。`PreparedTask.preparationTimeoutSeconds` 保存基础值，`BenchmarkRunPlan.preparation.defaultTimeoutSeconds` 保存缺省；Scheduler 传递本节点有效准备并发。各阶段开始时执行基础值乘 `min(C, 10)` 的时限，排队不计时，不取所有题目的最大值。

提前准备发生在单题执行预算之外。默认不设置整轮上限；配置覆盖、可选整轮限制、pipeline 忙时间计时及旧字段迁移只在[配置指南](../users/config.zh-CN.md#环境准备时限)维护。解题、评分及结果分类规则不因准备时限放宽而改变。

### 7.3 区分合法零分和运行失败

| 结果 | 当前处理 |
| --- | --- |
| 求解、验证正常结束，官方返回零分 | 合法评分、零分 |
| 质量评测中框架识别的 Agent 求解超时 | `agent_timeout`、有效零分；不继续正常验证，尽力保留已有证据 |
| 环境准备、环境启动或验证超时 | 失败，不能按普通答错记零分 |
| 用户取消 | 取消，不能记为普通零分 |
| 性能评测超时 | 按基础设施失败处理，不采用质量评测的 Agent 超时零分规则 |
| 已有合法评分后的收集或清理错误 | 评分可能保留，但产物及清理状态仍单独记录；不能声称资源已释放 |

普通阶段超时不属于自动网络补测。存在明确网络故障证据的失败按[网络补测规则](../users/network-retry.zh-CN.md)处理；一次补测可能重新获得 attempt 预算，实验总耗时和费用需另算。

取消验收需要检查实际进程、容器和文件写入是否停止，不能只看 CLI 已经返回。未确认清理完成时，不应直接复用已占用资源；取消与释放的代码要求见[生命周期与资源所有权](benchmarks.md#生命周期与资源所有权)。

## 8. 公开输入、网络和产物交付

### 8.1 公开与私有材料

Agent 只能获得公开题目和允许访问的环境。答案、隐藏测试与私有评分材料留给验证流程，不放入 Prompt、公开结构化输入、初始文件、公开 skills、求解镜像或公开构建上下文。仅在 Prompt 中不提答案不能阻止 Agent 从文件系统读取答案。

模型与裁判凭据通过服务绑定传入。Harbor Shell verifier 的裁判凭据只在验证脚本执行时注入，不写入任务描述和求解环境。结果、来源锁、轨迹和诊断日志必须脱敏。

### 8.2 分阶段网络

分别检查来源下载、构建/安装、Agent、verifier 的网络需求。Harbor 的任务基线在 `[environment]`，求解和验证分别由 `[agent]`、`[verifier]` 覆盖；独立验证也可有自己的环境基线。

- 求解 `no-network` 保留受控模型网关；离线验证不使用模型网关。
- 白名单支持当前实现范围内的 HTTP/HTTPS 域名，不是任意 TCP/UDP、IP/CIDR、端口或路径规则；精确域名不自动包含子域名。
- 镜像构建与运行时安装有自己的网络配置，不能用求解白名单推断其行为。
- Compose 服务组需要受支持的 bridge 网络组合，不能与当前不支持的隔离策略混用并静默降级。
- 检查节点能访问真实模型、裁判和 MCP 地址，协调端的 `localhost` 不是执行节点可用服务地址。

详细规则见[Harbor 网络与文件交付](../users/benchmarks/harbor.zh-CN.md#网络策略)。

### 8.3 shared 与 separate

| 模式 | 行为 | 接入检查 |
| --- | --- | --- |
| shared | 保留求解文件系统，在同一环境验证；默认用于未声明独立验证环境的 Harbor 任务 | 停止求解写入后才注入私有测试；不保证 Agent 后台服务继续运行 |
| separate | 按声明导出产物，确认求解环境回收后创建验证环境并恢复 | 所需文件必须可导出、可恢复，不依赖本机绝对路径或隐含共享磁盘 |

当前 Harbor 产物使用互不重叠的绝对容器文件/目录路径，可配置排除项和侧车来源，不支持任意 destination 重映射。需要工作区归档或 Git patch 等其他交付方式时，应确认所选协议支持，不能直接向 Harbor 添加自定义字段。

Harbor 对普通缺失交付物保留归档清单和 `ARTIFACT_COLLECTION_INCOMPLETE` 警告，继续交给官方验证器判分；权限、传输、摘要和路径安全错误仍中止。不能补造缺失文件，也不能把真实传输失败当作正常缺失。

## 9. 核对官方评分与结果口径

验证要遵守官方入口和奖励定义。Shell verifier 优先读取 `/logs/verifier/reward.json`，其次读取 `reward.txt`；主奖励必须是有限数值。无奖励、格式错误、配置的错误哨兵均属于验证失败，不能返回普通零分掩盖。脚本非零退出但产生有效奖励时，当前实现记录退出码并采用奖励。

验收前明确以下口径，并用已知输出核对：

- 主分数取哪个奖励字段，是否保留额外维度；成功阈值和错误哨兵是否来自官方规则。
- 合法零分、没有测得分数和验证失败分别处理；不能把缺失分数补成零分。
- 只有连续分数时，不擅自添加阈值生成正确率；性能评测检查负载、测量完整性、吞吐和延迟，不虚构正确率。
- 报告分母如何处理有效完成、Agent 超时、基础设施失败和排除题目；不能通过丢弃失败题提高分数。
- 模型裁判的版本、服务绑定、调用预算和联网条件固定；离线报告只读取已保存的证据，不重新调用裁判。

需要实现新的评分方法或结果格式时，转到[评分结果与诊断证据](benchmarks.md#评分结果与诊断证据)。

## 10. Harbor 配置示例

任务包可组织为：

```text
my-benchmark/
└── tasks/
    └── task-001/
        ├── instruction.md
        ├── task.toml
        └── tests/
            └── test.sh
```

下面选择官方镜像，因此不要求用 `environment/Dockerfile` 重新构建。**镜像地址和 digest 是占位值，必须换成官方发布且支持目标平台的实际引用；时间和资源同样需要核对。**

`task.toml`：

```toml
version = "1.0"
artifacts = ["/workspace/output"]

[task]
name = "task-001"

[environment]
docker_image = "registry.example.org/official/task-001@sha256:<64位摘要>"
os = "linux"
platform = "linux/amd64"
workdir = "/workspace"
cpus = 2
memory = "4g"
storage = "16g"
build_timeout_sec = 1200

[agent]
timeout_sec = 1800
network_mode = "no-network"

[verifier]
timeout_sec = 300
environment_mode = "separate"
network_mode = "no-network"

[verifier.environment]
docker_image = "registry.example.org/official/task-001-verifier@sha256:<64位摘要>"
platform = "linux/amd64"
cpus = 2
memory = "8g"
storage = "16g"
build_timeout_sec = 1200
```

本例验证镜像必须内置 `/tests/test.sh`；任务包仍提供 `tests/test.sh` 以满足当前 Shell verifier 的任务准备检查。两处应来自同一固定版本，避免实际执行与任务材料不同。输出目录是交付声明，Agent 需要按题目要求实际创建并写入。

如果上游没有专用验证镜像，可以不填 `verifier.environment.docker_image`，按第 4 节选择私有构建或回退环境，并检查测试交付；没有求解镜像时提供公开 `environment/Dockerfile`。

与 `my-benchmark/` 同目录的 `experiment.yaml`：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark:
  name: harbor
  config:
    dataset: my-benchmark@1.0
    source:
      kind: local
      path: ./my-benchmark
    tasks:
      root: tasks
      id: task.name
      expectedCount: 1
    defaults:
      workdir: /workspace
      buildTimeoutSeconds: 1200
    scoring:
      primary: reward
      passThreshold: 1
      errorValues: [-1]
  solver:
    name: simpleagent
    service: default
  verifier:
    name: harbor-shell

environment:
  name: docker
  platform: linux/amd64
  config:
    allowEmulation: false

scheduler:
  name: local
  concurrency: 1

run:
  timeoutSeconds: 2400
  verifyTimeoutSeconds: 300
  onError: continue

output:
  directory: ./results/my-benchmark
```

相对路径按实验 YAML 所在目录解释。用于 Ray 时替换 local 来源，并检查每个节点能拉取固定镜像、访问来源和读取节点自身认证。需要新增插件时，代码夹具和受控测试用法见[开发指南中的实现示例](benchmarks.md#三种可运行的接入示例)。

## 11. 分阶段验收

先完成安装与构建，再在仓库根目录执行；示例文件路径按实际位置替换：

```bash
ember-evaluator inspect experiment.yaml
ember-evaluator doctor experiment.yaml
ember-evaluator run experiment.yaml --dry-run
ember-evaluator run experiment.yaml
ember-evaluator report <run-dir>
```

外部插件在检查和执行时都传相同 `--patch <path>`。离线报告根据已保存插件来源装配，不要求再次提供 patch。`doctor` 执行下载和构建探针，不调用模型，dry-run 也不能代替实际运行验收。

| 验收项 | 通过标准 |
| --- | --- |
| 最终配置 | 来源、版本、平台、Solver、verifier、预算、并发与官方要求一致 |
| 官方镜像选择 | 选择声明镜像；不构建被替代的任务 Dockerfile；拉取失败保留错误 |
| 冷启动与热启动 | 无缓存和有缓存都能完成；实际镜像身份与目标平台可核对 |
| 平台边界 | 原生节点完成；禁止模拟时跨架构明确失败；模拟结果单独标注 |
| 资源 | 实测求解、验证及侧车峰值；CPU/内存限制生效；不把存储声明当强制配额 |
| 合法正分和零分 | 用已知正确、错误输出分别核对官方奖励与报告 |
| 超时与取消 | 求解、验证、准备超时和用户取消分别记录；进程、容器和写入停止 |
| 公开/私有边界 | Agent 无法读取答案、隐藏测试、私有镜像内容和裁判凭据 |
| 文件交付 | 验证环境获得全部所需产物；普通缺失与真实传输失败分开记录 |
| 失败证据 | 奖励缺失/错误、镜像或平台不支持、资源不足有明确错误与日志 |
| 并发 | 从 1 逐步增加，实测节点资源、模型限流、磁盘峰值及准备并发 |
| 续跑 | 来源、配置、插件身份未变时恢复；来源变更被拒绝，失败项按策略重做 |
| 离线报告 | 不调用模型或裁判，能从保存结果重建指标和报告 |
| Ray | 节点独立物化、镜像拉取、平台、插件版本、认证和 slot 容量均验收 |

验收记录分别标注静态检查、受控测试、真实运行、失败、跳过和待验收。插件回归测试不能代替这里的真实运行验收；代码检查和受控测试见[插件回归测试](benchmarks.md#插件回归测试)。

## 12. 接入完成的交付物

- 固定版本的数据来源、任务范围、来源锁及排除原因。
- 官方镜像来源、引用和实际身份，求解与验证平台、原生/模拟执行记录。
- 单题资源表、各项超时、准备预算和经过验证的并发配置。
- 可运行实验 YAML；需要扩展时提供插件、Profile、patch 与版本信息。
- 公开/私有材料、网络策略、产物路径和评分规则说明。
- 验收记录、可离线重建的结果，以及尚不支持或尚未验证的条件。

[返回开发文档](README.md) · [Benchmark 开发指南](benchmarks.md) · [Harbor 使用指南](../users/benchmarks/harbor.zh-CN.md)
