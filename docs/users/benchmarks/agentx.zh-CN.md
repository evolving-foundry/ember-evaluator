# AgentX 性能评测

> [English](./agentx.md) | 中文

AgentX 使用脱敏 trace 重建请求长度、前缀复用、会话轮次、子 Agent 依赖和等待时间，测量模型服务的吞吐和延迟。它没有 ground truth，`passed` 为 `null`，不输出正确率或奖励分数。实现固定使用 [agentx-harness 1.0.7](https://inferencex.semianalysis.com/agentx/quickstart) 的 `agentx` 场景。

![AgentX 按测量点回放固定 Trace，由 Python Harness 调用模型服务并生成性能摘要](../imgs/09-flowchart-agentx-performance-v2.png)

两种并发分别计数：外层 Scheduler 一次执行一个测量点，负载并发表示该点内的活动会话树数。子 Agent 可能增加实际请求并发，因此会话树数不等于同时发出的请求数。测量摘要进入性能报告，不产生质量分数。

## 硬件选择

实验顶层 `hardware: npu`（缺省值）使用现有 NPU 路径。设置 `hardware: gpu` 后，API 回放和 `telemetry.vllm` 仍可用；不要求回放机器安装 GPU。`telemetry.ascend` 与 GPU 选择冲突，`doctor`、`--dry-run` 和正式运行都会在启动采样前报错。GPU 硬件指标采集当前不支持。字段含义和续跑规则见[配置指南](../config.zh-CN.md#npu-与-gpu-选择)。

可使用 [GPU 服务 API 示例](../../../playbook/agentx/agentx-gpu-api.yaml)；该示例只回放请求，不采集设备指标。

## 准备与运行

推荐使用 `environment: local`。AgentX 在 Evaluator 所在环境通过模型 API 回放 Trace，不执行 Trace 中记录的真实工具操作，也不创建任务镜像或任务容器。可以在管理容器内运行，也可以直接在裸机运行；推理服务由用户提前手动启动，Evaluator 不启动或停止推理服务。

管理镜像已提供 Python、venv 和编译依赖，Evaluator 首次运行时在缓存目录自动安装独立的 AgentX venv，后续复用。直接在裸机使用 local 时，需已有 Python 3.11–3.13 和 venv 支持，可通过 `pythonExecutable` 或 `PYTHON_BIN` 指定解释器；只向独立 venv 安装 Harness，不自动安装裸机系统包或修改全局 Python。仍需独立任务容器时可显式使用 `environment: docker`，由 Evaluator 自动构建并准备任务环境。

模型服务需支持流式 OpenAI Chat Completions、`ignore_eos` 和 trace 指定的输出长度。默认使用官方 062126 256k 语料，服务应有至少 256k 上下文及足够余量；`full` 用于支持约 1M 上下文的服务。不会自动截断 trace 以适应较短的上下文。

第一次使用按 [AgentX 性能入门](../quick-start/agentx.zh-CN.md)完成安装、模型变量和 tokenizer 设置，再按 `doctor`、`run --dry-run`、`run` 的顺序执行配置检查和正式测评。该页提供完整命令；本文说明负载、测量口径和指标采集。`doctor` 执行下载探针，不推理；`--dry-run` 会按需下载数据并列出测量点。

按测评目标选择配置，不需要依次全部运行：

| 目标 | 配置 |
| --- | --- |
| 标准窗口与并发扫描 | [agentx-standard.yaml](../../../playbook/agentx/agentx-standard.yaml) |
| 在线模型 API，只统计请求与回放性能 | [agentx-model-api.yaml](../../../playbook/agentx/agentx-model-api.yaml)，不启用 telemetry |
| Docker 标准测评，裸机自动采集 NPU | [agentx-npu-docker.yaml](../../../playbook/agentx/agentx-npu-docker.yaml) |
| 前 50 条 Trace 完整回放，可能耗时较长 | [agentx-replay.yaml](../../../playbook/agentx/agentx-replay.yaml) |
| 两条 Trace，并采集 vLLM 与 NPU 4 指标 | [agentx-npu-replay.yaml](../../../playbook/agentx/agentx-npu-replay.yaml)，需先准备两个指标端点 |
| local 标准测评，裸机自动采集指定 NPU | [agentx-npu-local.yaml](../../../playbook/agentx/agentx-npu-local.yaml)，管理容器或直接裸机运行均可，多卡逐项填写 |

### 本地部署与在线 API 的模型变量

| 变量 | 自建推理服务 | 在线模型 API |
| --- | --- | --- |
| `MODEL_NAME` | `/v1/models` 返回的模型 ID，包括启动时指定的别名 | 服务商公布的模型 ID |
| `MODEL_ENDPOINT` | 推理服务的 OpenAI 兼容 base URL，如 `http://127.0.0.1:8000/v1` | 服务商的 OpenAI 兼容 base URL，如 `https://api.example.com/v1`，不是网页聊天地址 |
| `MODEL_API_KEY` | 服务配置的密钥；无鉴权时填 `EMPTY` | 服务商签发的有效密钥 |

完整导出命令见[快速入门中的两种接入配置](../quick-start/agentx.zh-CN.md#2-填写-yaml-和模型变量)。自建服务由用户手动启动，只有具备监控访问条件时才启用 telemetry；NPU 自动采样读取 Evaluator 所在裸机指定设备，不会访问远端模型机器的硬件。

在线 API 使用 [agentx-model-api.yaml](../../../playbook/agentx/agentx-model-api.yaml)，省略整个 `telemetry`。只能测客户端观测的请求与回放性能，**不能采集服务端推理引擎或 GPU/NPU 硬件指标**，不会用本机指标代替。接口还需支持 AgentX 要求的流式 Chat Completions、`ignore_eos`、上下文和输出长度；提供 OpenAI 兼容地址不代表满足这些条件。

`MODEL_ENDPOINT` 可以是服务 origin、以 `/v1` 结尾的 base URL，或完整 `/chat/completions` 地址。模型别名、服务商模型 ID 与 tokenizer 仓库名称可不同；推荐直接在 YAML 中填写匹配模型的 Hugging Face `org/repo` 或本机 tokenizer 专用目录，Docker 会上传该目录。旧示例中的 `AGENTX_TOKENIZER` 只是该字段的环境变量写法。省略 `tokenizer` 或写 `${MODEL_NAME}` 时使用模型标识，只有模型标识同时是有效 tokenizer 仓库名时才能直接使用。

首次运行会下载 trace、tokenizer 和 Python 依赖，所需墙钟时间大于测量窗口。`HF_ENDPOINT` 遵循[现有数据接入设置](../config.zh-CN.md)，`HF_TOKEN` 用于受限 tokenizer；`PIP_INDEX_URL` 可以选择 Python 包镜像。

Trace 数据集公开，原有示例无需额外设置 HF_TOKEN。需要为数据下载提供显式凭据时，可设置 `benchmark.config.hfToken: ${HF_TOKEN}`，支持 SDK `env`，省略时使用执行进程的 HF_TOKEN；旧 hfTokenEnv 不再接受。tokenizer 由用户随推理服务准备并通过现有 tokenizer 字段提供本机目录，不增加 tokenizer 认证参数。

## 并发与配置

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: agentx
  scenario: standard
  config:
    variant: 256k
    concurrency: [1, 4, 8]
  solver:
    config:
      tokenizer: ${MODEL_NAME} # 别名或在线 API 模型 ID 不是仓库名时，改填匹配的 tokenizer
      trustRemoteCode: false
environment: local
```

`concurrency` 表示活动会话树数，由 Harness 管理；子 Agent 会让请求并发高于该值。Evaluator 的调度并发必须为 1，各点依次运行，避免测量点争用同一服务。`run.maxTasks`、`run.taskIds` 和采样作用于测量点，不限制 trace 中的请求。

standard 默认测量 3600 秒；在现有 YAML 的 `benchmark.config` 中设置 `durationSeconds` 即可调整每个并发点的测量窗口，值必须为正整数。例如改为 60 秒：

```yaml
benchmark:
  name: agentx
  config:
    durationSeconds: 60
    concurrency: [1, 4, 8]
```

seed 仍固定为 42，保留 0.25–0.75 起点窗口、官方预热及原始 Trace 等待处理。非 3600 秒时自动向 Harness 传入 `--unsafe-override`，保留上游有效性判断，并在本地标记 `comparable: false`、原因 `custom_duration`，不能作为正式一小时可比成绩。

`durationSeconds` 只控制测量窗口，不包含准备、预热和收尾，因此设置 60 秒不代表整个命令在 60 秒内结束。默认任务总预算 `run.timeoutSeconds` 为 10800 秒，无需为 60 秒测量修改。总预算须至少为 `durationSeconds + 3900` 秒；延长测量导致默认预算不足时，需同时增大 `run.timeoutSeconds`，运行前会拒绝不足的预算。

`replay` 用于完整执行文件前 N 个 trace，必须显式设置 `traceCount`。例如上面的 replay Playbook 选择前 50 个会话，使用 8 个会话树并发，从每个会话的第 0 条请求开始，主 Agent 和子 Agent 的所有请求都完成后结束。仍沿用官方重建、依赖和等待处理；关闭额外的单 token 预热，完整请求均进入 profiling。这个场景包含冷启动和会话排空，始终不可比正式一小时结果。`durationSeconds` 默认为 86400，是安全上限；默认任务预算 172800 秒。若上限先到、请求缺失、重复或被取消，测量点失败并保留部分产物，续跑会整点重跑。并发不能大于选定会话数。

replay 的时间参数是安全上限，完成有限请求后允许提前结束，因此使用源请求坐标覆盖率替代官方固定测量窗口的时长覆盖要求。实际测量窗口和指标仍由 Harness 导出，回放结果始终不可比正式场景；standard 保留官方时间窗口校验。

Trace 数量少并不意味着回放很快：单条来源可包含数十个主请求、后台分支及数小时的原始等待。Harness 1.0.7 的全局空闲压缩仅在整个系统空闲时跳过部分等待，不等同于逐请求删除延迟。给两条 Trace 设置 600 秒安全上限，可能在请求均成功时仍因未派发全部来源请求而失败。排查时同时检查 `harness.log` 的 `timeout_triggered`、分支统计和 `replay-coverage.json`；先区分安全截止与请求/分支缺陷，保留原始负载后增加预算，不通过忽略延迟或删减分支制造完整回放。

Solver 可设置 `tokenizerRevision`、`requestTimeoutSeconds`、`trustRemoteCode` 和下述 `networkLatency`。tokenizer 首次解析为具体 commit 和内容摘要，续跑复用该 commit 并校验内容。`trustRemoteCode` 缺省为 false。输出长度由 trace 控制，不设置 `services.maxTokens`。支持范围限定为 `agentx-replay`、本地调度、local/Docker 环境和一次自动 attempt，不支持 Ray、普通 Agent Solver 或正确性 Verifier。

### 网络延时校准

在 `benchmark.solver.config` 中添加 `networkLatency`，使用官方 Harness 的 RTT 校准。省略整个对象时关闭，原始延迟和压测流程保持原有行为。local 和 Docker 均支持；探测由 Harness 在其执行环境中访问实际模型端点，`doctor` 与 `--dry-run` 不进行探测。

自动测量 TCP 握手 RTT：

```yaml
benchmark:
  name: agentx
  solver:
    config:
      networkLatency:
        mode: automatic
        pingIntervalSeconds: 1 # 可省略，默认 1 秒；必须大于 0
```

已知平均往返时间时，可改用手动设置，单位为毫秒：

```yaml
networkLatency: # 放在 benchmark.solver.config 下
  mode: manual
  meanMs: 5
```

`meanMs` 必须为非负有限数；手动模式不进行 TCP 探测，不能填写 `pingIntervalSeconds`。自动模式不能填写 `meanMs`。配置未知字段或混用两种模式的参数会在执行前报错。

校准结果保存在 `result.json` 的 `solve.observations.networkLatency`、`agent/agentx-summary.json` 及对应 `metrics.json` 中。报告逐测量点显示校准模式、用于扣除的平均 RTT、探测总数/成功数/失败数，以及 TTFT、TTFO 和请求延迟的原始值与修正值（均值、P50、P95、P99）。修正分布直接读取官方 `network_adjusted_*` 导出，不在 Evaluator 中重算。ITL、吞吐和报告原有性能对比表继续使用原始指标。

`complete` 表示有可用 RTT 和对应修正指标；部分探测失败、探测记录缺失或部分修正指标缺失时记为 `partial`，保留已有数据和告警；没有可用 RTT 或修正指标时记为 `unavailable`。缺失值显示 `—`，不补成 0，也不让网络校准缺失替代请求测评的成功/失败判断。固定版本 Harness 对手动 `meanMs: 0` 可能不导出校准指标，此时明确显示不可用，原始指标仍保留。

自动模式的逐次探测保存在 Harness 产物 `profile_export_network_latency.jsonl`，随 `artifacts/artifacts.tar` 收集；手动模式没有探测文件。旧结果没有网络校准字段时仍能生成报告。离线 `report` 仅读取保存结果，不重新探测或访问模型。

平均 TCP RTT 校准只估算客户端到端点的网络往返，不能去掉所有代理、传输或客户端开销，也不会改变网络对实际吞吐和会话推进速度的影响。参数和指标定义见[官方网络延时校准说明](https://github.com/SemiAnalysisAI/agentx-harness/blob/master/docs/metrics-reference.md#network-latency-calibration-metrics)。

## 结果、续跑与离线报告

每个并发点对应独立 attempt，保存：

- `agent/agentx-summary.json`：版本化摘要；同一摘要也保存在结果的 `solve.observations`。
- `agent/trajectory.jsonl`、`session.jsonl` 和脱敏桥接日志。
- `artifacts/artifacts.tar`：Harness 原始导出和日志，包含内部 `agentx-artifacts` 目录；失败时保留可收集的部分产物。
- replay 另存 `agent/replay-coverage.json`，按 trace id、原始外层/内层索引核对请求覆盖率；同一证据也收入原始产物包。报告展示完成的 trace、采集请求、失败、取消、缺失和重复数量。

报告分别展示 profiling 与 warmup；TTFT、ITL、请求延迟和 Interactivity 的分布来自官方导出，吞吐使用 Harness 的测量时间，各点的分位数不合并。缺失值显示未知，token usage 只统计预热和测量均有数据的字段，不代表服务商账单。

配置多个并发点时，根 `report.md` 只列出测量点状态和独立报告链接。例如 `[1, 4, 8]` 分别生成 `points/c1/report.md`、`points/c4/report.md`、`points/c8/report.md`，同目录各有一份 `metrics.json`。每份报告只包含本档的请求性能、预热、vLLM、逐设备/芯片 NPU 指标、耗时、token usage 和 attempt 记录；不混入其他档位的统计。失败或尚未运行的档位也有独立状态页。只有一个并发点时，详细报告仍为根 `report.md`。

根 `metrics.json` 保留整批机器数据和子报告目录，便于程序读取；各点指标从各自记录重新计算。各点报告中的原始结果链接仍指向本 run 下对应的 attempt，不复制轨迹和原始产物。整批继续共用一个 run ID、来源锁定和续跑状态，三档按顺序执行。

`upstreamSubmissionValid` 保留 Harness 的判断，`comparable` 另行检查场景、来源和测量完整性。比较结果时应保持语料 commit、场景、tokenizer、并发及部署条件一致。完成一次回放不代表满足排行榜提交条件。

```bash
ember-evaluator run playbook/agentx/agentx-standard.yaml --resume
ember-evaluator report results/agentx-standard/RUN_ID
```

完成点跳过，失败、取消和超时点使用新 attempt 整点重跑，不续接某条请求。性能超时不产生零分。`report` 同时重建目录页和各点报告，可修复缺失或损坏的子报告；仅使用保存结果和内置报告插件，不需要 Python、模型认证或原数据缓存。显式 `--resume` 将续跑报告及各点子报告另存到 `reports/resume-N/`，保留旧报告；`retry` 和离线 `report` 更新当前报告，保存方式见[续跑与重建报告](../usage.zh-CN.md#续跑与重建报告)。

## vLLM 与 Ascend NPU 指标

`benchmark.solver.config.telemetry` 可分别启用 vLLM 和 Ascend 采集；省略时只测会话性能，不探测监控端点、不调用设备工具。已有 AgentX Harness 负责 Prometheus 采集和 profiling/warmup 聚合，Evaluator 负责保存及展示各来源结果。

这些监控配置用于有监控访问权限的自建服务。直接使用在线模型 API 时不配置 telemetry，不能采集服务端引擎与硬件指标；模型 API 的响应不是 Prometheus 监控端点。

Evaluator 与 NPU 位于同一服务器、使用 `environment: local` 时，可以自动启动裸机采样，不需要提前运行 `ascend_metrics.py`。Evaluator 在管理容器中时通过 toolbox 控制通道调用裸机采样；直接在裸机运行时自动启动本机 Python 子进程，无需管理容器。在现有 `benchmark.solver.config` 中配置：

```yaml
telemetry:
  vllm:
    endpoint: http://127.0.0.1:8000/metrics
  ascend:
    mode: local
    devices:
      - deviceId: 0
      - deviceId: 1
```

设备号必须换成推理服务实际使用的 `npu-smi` NPU ID；不自动选择服务器的其他设备。未填 `chipId` 时，通过 `npu-smi info -m` 查询该设备的计算芯片，排除 MCU。需要限定某个芯片时填写 `{ deviceId: 0, chipId: 0 }`。设备列表不得为空或重复；`deviceId`/`chipId` 不一定等于模型进程中的逻辑设备编号。

每个测量点在 Harness 启动前自动创建回环采样端点，端口自动分配，覆盖预热及正式测量。结束、失败、超时和取消后停止采样并关闭端口。采样所在裸机必须已有 Python 3.9+ 和 PATH 中的 `npu-smi`；各芯片独立执行有超时限制的只读查询。单卡故障保留其他卡和会话数据，报告显示逐卡诊断，不把缺失值补零。

`bash scripts/toolbox/run.sh` 自动准备经过令牌认证的裸机控制通道，只有 AgentX `run` 请求指定卡号时才开始查询设备。local 和 Docker 都优先使用该通道；未配置通道时，只允许在裸机直接启动标准库 Python 子进程。容器缺少通道时，`doctor` 检查失败，实际运行记录采样不可用原因，不回退到容器内查询。`doctor` 只检查控制通道或程序可用性，不查询设备；`--dry-run` 不启动采样。管理容器不映射 NPU，不需要安装 npu-smi。

使用 `environment: docker` 时，Harness 仍在独立任务容器中运行，采样仍在 Docker 宿主机执行。任务使用显式 host 网络访问模型及回环采样端点，任务容器也不映射 NPU。采样程序不提供模型启动或任意 shell 命令接口。

裸机采样只允许 `npu-smi info -m` 和显式设备/芯片的 `info -t usages|memory|power|temp`。不会执行 `npu-smi set`、改 device-share、安装包、改系统文件或绑定设备到管理/任务容器。仅在工作目录保存控制和诊断文件。Docker 示例见 [agentx-npu-docker.yaml](../../../playbook/agentx/agentx-npu-docker.yaml)；不需要手动启动采样脚本、额外的执行容器或 SSH Worker。

可使用[local Ascend 标准测评示例](../../../playbook/agentx/agentx-npu-local.yaml)。启动 vLLM 后，导出模型变量，在 YAML 中填写匹配的 tokenizer、`vllm.endpoint` 和实际设备号，再执行 `doctor`、`run --dry-run` 和 `run`。前两步不启动设备采样。InfraAgent 仍通过原 SSH worker 运行这些 CLI 命令，只需在生成的 YAML 中加入上述采样配置；无需另起采样服务，也无需传入 NPU 采样端口。

外部已运行的采样服务继续使用 `endpoint` 配置；不能与 `mode: local` / `devices` 混用。Evaluator 只抓取外部端点，不启动或关闭该服务：

```yaml
benchmark:
  name: agentx
  scenario: replay
  config:
    traceCount: 2
    concurrency: [1]
  solver:
    config:
      tokenizer: ${AGENTX_TOKENIZER}
      requestTimeoutSeconds: 1800
      telemetry:
        vllm:
          endpoint: http://127.0.0.1:18094/metrics
        ascend:
          endpoint: http://127.0.0.1:18095/metrics
          deviceId: 4
          chipId: 0
```

可直接使用 [Ascend 两条 Trace 示例](../../../playbook/agentx/agentx-npu-replay.yaml)，额外设置 `VLLM_METRICS_ENDPOINT` 和 `ASCEND_METRICS_ENDPOINT`。这两个 URL 必须是 Harness 执行环境能够访问的完整 HTTP(S) 指标地址，不能包含用户名、密码、查询参数或认证值。Docker 内的 localhost 指向容器自身，需要另外安排端口访问。

地址按 Harness 规则去除末尾斜线，未以 `/metrics` 结尾时追加该路径。两个来源可以使用同一监控地址，仍按指标名、模型标签和设备标签分别读取。

vLLM 端点使用服务的 `/metrics`。报告包含 KV cache 使用率、运行/等待请求、抢占、prefix cache 查询/命中和输入/输出 token；字段按实际版本明确匹配。Counter 显示测量窗口内增量及每秒速率，不使用启动后的累计值。Counter 按采集顺序累计相邻差值，服务重启后的计数重置也会记录。模型标签、端点和 profiling/warmup 分别计算，窗口内首个快照使用前一次采集值作基线。

上游原始 JSON/JSONL 保持不变。报告中的 Counter 使用按采集顺序计算的结果。速率分母为实际末次入窗快照与基线的时间差，时间差不为正时显示为空。窗口外快照不计入，因此 Counter 与逐请求 token 汇总可能存在采样边界差额；采样间隔内丢失的历史计数也无法恢复，报告不会用请求 token 数替换设备端计数。

硬件采样端使用 NPU 服务器现有的 Python 3 和驱动提供的 `npu-smi`，不需要额外 Python 包。

使用 SSH + 远端 Python Worker 下发容器任务时，也可以由 Worker 在裸机自动启动采样端、将动态端点注入上述 `ascend.endpoint`，并在 CLI 结束、失败或取消后停止采样。该部署只需要服务器已有 Python 标准库和只读 `npu-smi info`，不安装裸机依赖、不执行 `npu-smi set`。管理容器只下发任务，AgentX 在独立执行容器中运行；两者无需映射 NPU，只有推理容器映射实际计算卡。

这是可选的旧部署方式，常规 CLI 流程不依赖该 Worker。端点必须能从执行容器访问：AgentX Docker 的 host 网络可以访问裸机回环地址，其他网络方式需要明确可达的地址。若选择独立维护采样服务，可手动启动：

```bash
python3 dist/runtimes/agentx/assets/ascend_metrics.py \
  --device-id 4 --chip-id 0 --host 127.0.0.1 --port 18095
```

程序只执行带固定 `-i 4 -c 0` 的 usages、memory、power、temp 查询。目标采样间隔为 1 秒，每轮串行执行四条查询，实际更新间隔受命令耗时影响；单条命令默认超时 2 秒。可通过 `--interval` 和 `--command-timeout` 调整。快照有效期为 `max(3 × 采样间隔, 4 × 单条命令超时 + 采样间隔)`，默认 9 秒，避免上一轮有效快照在新一轮查询尚未完成时被过早判为失效。查询失败或超过有效期时 `/metrics` 返回 503，后续成功采样后自动恢复，不会把缺失数据记为 0。SIGTERM/SIGINT 会停止 HTTP 服务和采样线程；正在执行的查询最多等待其超时。

硬件报告按设备和芯片展示 NPU/AI Core 利用率、HBM 使用率/容量/带宽、功耗和温度，不将不同芯片的利用率合并为整卡利用率。HBM 容量单位沿用 npu-smi 的 MB，不用取整后的百分比推算精确已用内存。只有用户手动启动的推理容器映射计算卡；管理容器和任务容器不映射 NPU。配置填写裸机物理卡号，不能直接假设它等于推理容器内的逻辑设备号。

远端服务建议绑定回环地址，通过 SSH 转发访问，例如：

```bash
ssh -N -L 18094:127.0.0.1:18094 -L 18095:127.0.0.1:18095 user@server
```

SSH 认证属于部署操作，不写入实验 YAML。模型必须支持所选 Trace 的完整上下文和输出长度；262144 上下文的小模型仍需在单卡上实际验证。服务启动、模型安装及预检不计入请求指标。

`agentx-summary.json` 保存各来源的状态、标签序列、缺失指标、profiling/warmup 窗口及样本数；样本数统计上游 JSONL 中窗口内的不同快照，不等于 HTTP 抓取次数。上游聚合窗口可能延伸至最终采样，报告显示实际边界。原始 `server_metrics_export.json` / `.jsonl` 随 attempt 保存。临时抓取失败后沿用 Harness 的下一周期采集，不中止请求测评，也不丢弃已获得的监控统计；数据完全不可用或所需指标缺失时仍明确标记。离线 `report` 不访问设备或指标端点。

新结果保存 telemetry v2，支持多个设备/芯片和发现失败时的空端点；历史 v1 单卡结果在读取入口转成 v2 后离线重建，后续计算和报告只处理 v2，原始文件不回写。本机采样另在 Harness 产物中保存 `local-telemetry.json`，包含设备、芯片、动态端点和采样错误。来源状态表示所需统计的数据可用性：`complete` 表示所需指标有可用统计，不保证每次抓取成功；`partial` 表示部分数据或指标缺失；`unavailable` 表示无法获得可用统计。已有统计时，采样过程诊断保存在来源的可选 `warnings` 中，并在报告中展示。请求性能与监控状态分别判断，监控告警不改变 Harness 的 `submission_valid` 或请求性能可比性。

适配会把上游累计采集错误数写入原始导出的 `evaluator_collection_error_count`，并在摘要的可选 `telemetry.collectionErrors` 中保存。该计数是全部端点合计，只在报告中展示一次，不分配给每个来源，也不据此自动把所有来源改成 `partial`。历史摘要缺少该字段时显示“未记录”，不假定错误数为零。

[返回用户手册](../README.zh-CN.md) · [快速上手](../quick-start.zh-CN.md)
