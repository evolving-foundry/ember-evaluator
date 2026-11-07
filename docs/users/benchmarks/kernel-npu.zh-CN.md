# 已有 kernel 的 NPU 评测（kernel-npu）

> [English](./kernel-npu.md) | 中文

`kernel` 在昇腾 NPU 上验证已有候选，输出正确性、参考耗时、候选耗时和加速比，并可采集候选的详细硬件性能指标。`kernel-replay` 仅提交固定产物，不生成或修复代码，不调用模型。独立运行只需要 Evaluator、输入样例和 NPU 运行时。与 RSI 联合使用时，由 RSI Proposer 生成新候选，再通过完整 SDK 评测冻结产物；正确性、计时和详细 profiling 均由本协议完成。静态源码诊断、模型分析瓶颈和修改 kernel 由优化器负责。

## 硬件选择

实验 YAML 使用顶层 `hardware: npu`，省略时也默认 NPU。`hardware: gpu` 会在读取候选和启动 Python 前报“Kernel GPU backend is not implemented”。内置计时只使用 NPU profiler，缺少 NPU 时失败，不回退 CUDA 或 CPU。`kernel precision/bench/profile` 独立命令仍为 NPU 入口。配置示例见[已有 kernel 评测](../../../playbook/kernel/existing.yaml)。

## 环境与运行

先按[安装指南](../installation.zh-CN.md)准备 Evaluator 依赖。AgentBundle SDK 由 pnpm 从 GitHub 自动下载并构建，不需要同级源码仓库；即使不使用 AgentBundle Solver，内置插件的静态导入仍需要该依赖。

需要 Linux、可用 NPU、CANN、torch、torch_npu、triton-ascend；详细采集模块还依赖 pandas、NumPy 和 Jinja2。Python 应使用已验证可运行算子的解释器；启动前加载其 CANN 环境。仅支持 `local` 环境与 `local` 调度器，并发固定为 1；确保指定设备没有其他计时任务。验证由本 Benchmark 内置 worker 执行，不能另配 `benchmark.verifier`。local 工作区不隔离恶意 Python 代码，只评测可信代码。

```bash
export KERNEL_EVAL_PYTHON=/absolute/path/to/venv/bin/python
export KERNEL_MANIFEST=/absolute/path/to/cases/tasks.json
export KERNEL_EVAL_PLACEHOLDER=unused-local-evaluation
pnpm build
ember-evaluator run playbook/kernel/existing.yaml --dry-run
ember-evaluator run playbook/kernel/existing.yaml
```

示例 YAML 中的 service 是框架必填字段占位，地址不可用。现有配置加载器要求 `api_key` 引用非空环境变量，因此设置 `KERNEL_EVAL_PLACEHOLDER` 为上述普通文本即可，不要填写真实模型密钥。模型用量为零；离线 `report` 不需要该变量。

## 任务文件

清单中的路径相对清单目录，必须列出参考和候选依赖的文件，不能使用绝对路径或 `..`。依赖按原相对结构放入验证工作区。候选应是自包含的 Python 文件，或只依赖明确列出的公共辅助模块。

候选与参考均保留在 `data/<清单相对路径>`，不会将候选重命名后移出原目录。支持同目录辅助模块、包内相对导入，以及以清单根目录为起点的包导入；相关 `.py` 和 `__init__.py` 文件均须列入 `files`。参考与候选在同一 Python 进程中运行，辅助模块应使用不冲突的名称，优先使用明确的包路径。

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "operator-example",
      "problem": "problem.py",
      "candidate": "candidate.py",
      "files": ["input.py"],
      "referenceKind": "original-kernel",
      "outputIndices": [0]
    }
  ]
}
```

- `problem.py` 提供 `Model`、`get_inputs()`，可选 `get_init_inputs()`。参考调用为 `Model(*get_init_inputs())(*get_inputs())`，模型转到 NPU 并设为 eval。
- 候选提供 `kernel_function(*inputs)`。严格任务契约可通过 `inputUnmodified: false` 允许候选修改输入；输出与输入共享存储时，还需设置 `output.independent: false`。输出仍须与参考数值一致，并符合契约的形状、dtype、设备和布局。任务作者须显式提供参数、权重、状态和入口签名，Evaluator 不会推断这些信息。
- 当前验证算子调用的输出等价性，不验证回填 Inductor 时的符号替换契约，也不代替整个模型的端到端回归测试。
- `referenceKind: pytorch` 表示可信的 PyTorch 数学参考；`original-kernel` 表示与原始 kernel 的输出等价，不能据此声称独立验证了数学正确性。此字段由任务作者根据参考源码选择。
- 默认比较完整输出，包括嵌套 tensor/list/tuple/dict 和标量。只有显式声明 `outputIndices` 才选择顶层 tuple/list 的指定元素。某些导出的输出含 `(tensor, tiling参数...)`，此时可用 `[0]` 排除非计算输出的元数据；多 tensor 输出须保留所有相关索引。
- 固定种子，每个种子重复调用候选两次。比较形状、dtype、设备与数值；Tensor 和嵌套 Python 浮点标量均检查有限性。参考含 NaN/Inf 属于无效评测，候选含 NaN/Inf 判为不通过。参考及候选输入分别复制并保留 stride。

来源锁包含清单、候选、参考、依赖、验证入口 `precision.py`、计时模块 `timing.py`、`strict.py`、`timing_evidence.py`、采集目标 `msprof_replay.py`（被 msprof 进程 attach 跑算子的重放脚本）的 SHA-256。变化后必须新建 run；续跑会拒绝变化。依赖文件在 Solver 结束并切换到验证阶段后注入，Solver 的公开输入不包含参考内容。

## 严格任务契约与计时审计

Manifest 的任务可提供 `contract`，包含 schemaVersion 1、caseId、输入张量契约、输出张量契约与 inputUnmodified。张量声明 shape、dtype（`float16`）、contiguous；输出还声明 independent。旧清单可以省略契约。严格评测对每个 seed 执行两次，检查入口、形状、类型、设备、布局、输出独立性、输入不变性与数值一致性。结果保存契约摘要、逐项检查、有效协议和实际环境。参考实现或基础设施失败属于无效评测，候选失败属于候选问题。

例如，为实际输入与输出符合以下形状的任务添加此 `contract`：

```json
{
  "schemaVersion": 1,
  "caseId": "operator-example",
  "inputs": [{ "shape": [2, 4], "dtype": "float16", "contiguous": true }],
  "output": { "shape": [2, 2, 2], "dtype": "float16", "contiguous": true, "independent": true },
  "inputUnmodified": true
}
```

严格成功要求所有检查通过，并取得 Python、torch、torch_npu、Triton、CANN、驱动、设备与可见设备的实际身份。缺少环境身份属于无效测量。`verdict.details.assessment` 保存检查和实际设置；Benchmark 会与请求的 seeds、容差、warmup 和 repeat 核对。

严格计时保存 schemaVersion 2 / `profiler-flow/v1` 证据，通过 CPU→NPU flow 关联分配设备 kernel 到 profiler Step。原 CSV Step Id 原样保留，不改写，也不作为唯一关联依据。审计拒绝缺失或歧义证据并排除 warmup Step。均值包含每次调用的全部设备 kernel，不包含主机发射时延；CSV 与 trace 随结果保存。公共 SDK 导出契约、assessment、计时证据解析和逐样本审计接口。

## 详细性能采集

NPU backend 负责 Python/msprof 执行、设备绑定和清理；Benchmark 负责任务身份与裁决验证。默认 `operation: evaluate` 在精度和计时成功后可采集诊断。独立 `operation: profile` 要求单任务、单 seed、`profiling.enabled: true`、`cacheEnabled: false`，跳过精度与计时，返回不带候选分数的 performance 结果。

```yaml
benchmark:
  name: kernel
  config:
    operation: profile
    manifest: ${KERNEL_MANIFEST}
    python: ${KERNEL_EVAL_PYTHON}
    device: 0
    seeds: [42]
    timeoutSeconds: 900
    profiling:
      enabled: true
      collection: Default
      warmup: 25
      attemptTimeoutSeconds: 300
      maxAttempts: 2
      cacheEnabled: false
run:
  timeoutSeconds: 960
```

此片段合入包含上述占位 service 的实验配置。`benchmark.config.device` 选择一张物理卡：两个可见设备变量均固定该卡，worker 使用逻辑设备 0；继承的多卡环境变量不会扩大设备范围。

以下字段均位于 `benchmark.config.profiling`：

| 字段 | 默认值与行为 |
| --- | --- |
| `enabled` | `false`；关闭时评测仍运行正确性与标准计时 |
| `warmup` | 采集前重放 `25` 次，与用于计时的 `benchmark.config.warmup` 分开 |
| `attemptTimeoutSeconds` | 每个 profiler 进程 `300` 秒 |
| `maxAttempts` | `2`，包含首次；缺少必需 CSV 等结构性缺失不重试 |
| `retryDelayMs` | 可选非负整数，控制每次重试前的等待；`0` 不等待。省略时按 2s、4s、… 指数退避，并拆成 Node 支持的定时间隔 |
| `roundNum` | `1`；用于产物名和元数据，不代表重复采集次数 |
| `msprofBin` | 可选的现有可执行文件路径；省略时依次尝试 `/usr/local/Ascend/ascend-toolkit/latest/bin/msprof` 和 PATH 中的 `msprof` |
| `cacheEnabled` | 评测模式默认 `true`；独立 `operation: profile` 必须显式设为 `false` |
| `cacheDir` | 可选缓存目录；该字段不会相对实验 YAML 重定位，应使用绝对路径 |
| `cacheMaxEntries` | 可选正整数；只有显式配置容量时，写入后才淘汰最旧缓存条目 |
| `deviceName` | 为已有配置保留；当前不会据此补入硬件分母或启用 UB/核利用率派生指标 |

`benchmark.config.timeoutSeconds` 限制整个验证阶段，包括正确性、计时和 profiling。开启 profiling 时默认 `maxAttempts * attemptTimeoutSeconds + 300`，否则为 `300`。`run.timeoutSeconds` 必须大于此上限；开启 profiling 并使用默认 900 秒验证上限时，内置 Profile 的 360 秒 run 默认值不够。需为重试退避和解析留出时间；外层超时可能在完整回执写出前中断采集。

`benchmark.config.seeds` 接受任意非空、无重复的无符号 32 位整数列表。计时 `warmup`、`repeat`、profiling 预热、尝试次数和超时均由调用方配置为正整数，不额外限制 seed 数量或迭代次数。独立 profiling 的采集回执仍要求单个 seed。

以下进程控制字段直接放在 `benchmark.config`：

| 字段 | 默认值与行为 |
| --- | --- |
| `outputLimitBytes` | 省略时保留完整 worker/profiler 输出；显式正整数分别限制 stdout/stderr，超出时采集失败 |
| `cleanupGraceMs` | `100`；kernel 结果读取器与 profiler 清理使用的优雅停止等待时间 |
| `cleanupTimeoutMs` | `3000`；停止 profiler 后确认其退出的等待时间；无法确认退出仍属于基础设施失败 |

即使子进程在开始消费输出前已经退出，完整协议输出也会保留。原生 worker 错误和严格检查消息不按字符截断。Profiler 成功与非零退出均保留原始控制台日志。省略 `cacheMaxEntries` 时不自动淘汰缓存条目。

超时与清理等待须在 Node 定时器的 2147483647 毫秒范围内，超出时在执行前拒绝。重试等待可超过单次定时范围，会分段等待而不缩短请求时长。

Replay 使用未修改的 `problem.get_inputs()` 和配置中的第一个 seed，预热完成后仅在 MSTX 区间 `rsi_operator_profile` 内调用一次。SDK session 管理 profiler 子进程；取消信号传播至这些子进程，清理无法确认属于基础设施失败。

支持两个显式采集协议：

- 默认 `PipeTimeline,Default` 要求 PipeUtilization、L2Cache、ResourceConflictRatio 三类 CSV 和可用 trace。
- `Default` 要求上述三类 CSV，将 trace 标为 unavailable，原因为 `not-requested-by-default-protocol`；流水重叠、气泡与 Double Buffer 分析为 null，不宣称完整协议通过。

缺少必需证据时诊断不可用，与候选数值错误区分。保留原始 CSV、可用 trace、replay 元数据与进程日志。源码身份、case、seed、warmup、collection 和设备环境共同标识可复用证据。独立 profile 关闭磁盘缓存，由调用方管理复用；evaluate 模式可显式使用缓存。

`KA_MSPROF_CACHE_DISABLED=1` 会禁用磁盘缓存，即使显式设置了 `cacheDir`。否则目录依次取 `cacheDir`、`KA_MSPROF_CACHE_DIR`、`~/.kernel_agent/msprof_cache`。命中要求候选字节、参考哈希、case、seed、warmup、collection 与设备范围一致；缓存中的 replay 元数据会重新校验，仍可读取的缓存 profile 证据复制到当前 attempt。`profiling.metadata.cacheRequested`、`cacheEnabled` 与 `cacheHit` 分别表示缓存请求、实际启用和复用。

发布已完成的独立诊断前，Benchmark 核对有效 case/seed/warmup/collection、trace 可用状态、冻结候选与参考哈希，以及 replay 逻辑设备 0；不匹配属于验证失败。采集失败返回 `verdict.details.status: unavailable`、`verdict.passed: null`，不包含候选分数，与完整评测中的候选不正确区分。

指标解析沿用 ngo-agent 的 block 表、末行选择和数值保留三位小数。空白、非数值和非有限 CSV 单元格不进入逐 block 指标，真实零值保留。Roofline 缺少的输入保持 null。依赖硬编码硬件规格推导的 UB 占比与核利用率标为不可用；硬件事实来自已核实上下文。Roofline 分类只提供方向，不能证明加速。Profiler 耗时不替代 referenceMs/candidateMs。

| 指标字段 | 单位与含义 |
| --- | --- |
| `aic_time(us)`、`aiv_time(us)` | profiling 样本的微秒耗时 |
| `aic_*_ratio`、`aiv_*_ratio` | 按字段名区分的管道利用率、等待、冲突或算术比值；不是百分数、GB/s 或 FLOPS |
| `aic_read_hit_rate(%)` 等 L2 命中字段 | 百分数 |
| `aiv_gm_to_ub_bw(GB/s)`、`aiv_main_mem_read_bw(GB/s)` | 实测 GB/s |
| `GM_to_UB_bw_usage_rate(%)` | 带宽利用率百分数 |
| `read_main_memory_datas(KB)`、`write_main_memory_datas(KB)` | 原始 KB，不换算为 KiB |
| `aiv_mte2_instructions` | 指令数 |
| `l2_cache_analysis` | 结构化结论和支持证据 |

`Memory.csv` 与 `ArithmeticUtilization.csv` 可选，相关字段可能不存在，包括只有 Cube 的算子。新采集成功要求必需表存在，且至少有一个有限、范围为 0–1 的核心管道比值。消费单项指标前，检查原始 CSV 以及存在时的 `profiling.metadata.metricUnits`、`missingMetrics`。

## 指标与结果

常规评测类型为 `quality`，独立诊断为 `performance`。`passed/score` 只表示输出等价性，通过为 1，候选错误或不正确为 0。正确但更慢的候选仍为通过，`speedup < 1`。

计时模块已迁入 Evaluator，默认使用随包发布的 `timing.bench_kernel_ms`，无需访问外部源码目录。兼容已有配置时，可以显式设置 `benchmark.config.kernelRoot` 使用该外部仓库的计时模块；此时来源锁包含外部模块，且适用外部模块自身的计时行为。参考与候选均使用 `triton_only=False`，统计整个调用中所有设备 kernel 的耗时，不含 CPU 发射开销。内置计时器保留真实 ReduceSum 等归约耗时，逐行验证 CSV 耗时是否为有限非负数；缺列、空数据、记录数不完整或非正总耗时均视为无效测量。预热在有效样本之外，耗时单位为 ms。当前计时使用最后一个测试种子的输入；多种 shape 应拆成独立任务。

`metrics.json` 的 `metrics["kernel"]` 字段包含：

| 字段 | 含义 |
| --- | --- |
| `selected / valid / invalid / pending` | 所选、已判定、无效和未完成任务数 |
| `passed / measured / faster` | 正确、有完整计时、正确且加速的任务数 |
| `passRateValid` | 正确数 / 有效判定数 |
| `passCoverage / fasterCoverage` | 正确数或加速数 / 全部所选任务数 |
| `geometricMeanSpeedup` | 仅正确且完整计时任务的加速比几何均值 |
| `profilingRequested` | 已保存结果中明确请求详细采集的任务数 |
| `profiled / profilingErrors / profilingUncollected` | 详细采集完成、失败、已请求但未采集的任务数 |
| `profilingCoverage` | 详细采集完成数 / 全部所选任务数 |
| `rows` | 各任务参考种类、状态、两种耗时、加速比、详细采集摘要与证据路径 |

缺少 NPU、参考失败、计时缺失或非法、worker 协议错误以及验证超时属于无效评测，不当作候选零分。无数据的指标为 null，不写 NaN/Infinity。不要只看成功样本的平均加速比而忽略覆盖率。

`faster` 按加速比严格大于 1 计数，不代表统计显著提升；接近 1 的差异需要重复实验判断。运行前保持驱动和 Python 依赖版本一致，来源锁不替代环境版本管理。

评测 attempt 保存 `verifier/kernel-result.json`；独立 profiling 将校验后的诊断回执保存为 `verifier/kernel-profile-result.json`。Profiling 保存 `verifier/kernel-profile.json`、`kernel-profile.raw.json` 和 `kernel-profile_profiling_root/` 产物树，包含 replay 元数据、原始 CSV、请求的 trace、`profiling/original-result.json` 和日志。通过 `profiling.artifacts` 获取相对 verifier 的实际路径。采集失败时检查 `profiling.error`、`profiling/logs/profiler.log` 和 `profiling/logs/console.log`；replay 错误可能是下游 CSV 缺失的原因。超时没有完整结果时查看 attempt 的 `errors`；框架负责停止 worker 进程组。已保存结果支持离线报告重建。

`report.md` 给人阅读：新结果注明“原 kernel”，展示原返回指标、L2 结论、采集状态及证据链接；历史 LAST 或无输出策略结果保持原口径。`metrics.json` 是总体覆盖率与逐题摘要，字段值不会根据当前代码重新采集。RSI 需要性能反馈时读取 `tasks/<task-key>/attempts/<attempt-id>/result.json` 的 `verdict.details.profiling`：

```text
profiling.schemaVersion = 1
profiling.status / error                    # 采集状态与错误
profiling.kernels[].name                    # kernel 身份
profiling.kernels[].metrics[blockId]         # 所选 block 中可用的字段
profiling.kernels[].metadata.outputPolicy   # kernel-original-f542-v1；历史结果为旧值或无此字段
profiling.kernels[].metadata.upstreamCommit # 固定的来源实现提交
profiling.kernels[].metadata.originalMetadata # 采集路径、轮次与时间
profiling.metadata.diagnosticProtocol       # 有效 case、seed、warmup、collection、范围与选择策略
profiling.metadata.sources                  # 冻结候选/参考哈希与可选契约哈希
profiling.metadata.replay                   # 实际重放参数、设备与 MSTX 采集信息
profiling.metadata.trace                    # trace 可用状态与原因
profiling.metadata.cacheRequested / cacheEnabled / cacheHit # 缓存请求、实际启用与复用
profiling.metadata.hardwareDerived          # 不可用的硬件派生字段与原因
profiling.analysis.trace / roofline         # 不可用的分析分别为 null
profiling.artifacts                        # 相对 verifier/ 的原始证据路径
```

旧结果可能包含 `originalResultJson`、`originalReturnedNone` 或 `serializationConversions`；当前采集不要求或生成这些元数据字段。当前 `original-result.json` 通过 `profiling.artifacts` 定位。历史记录沿用已保存指标，不重新采集或改变定义。

调用方通过 `executionStatus`、`scoreStatus`、`verdict.passed` 判断原有正确性和计时是否有效，通过 `profiling.status` 单独判断详细采集是否返回结果；采集失败不等于候选不正确。需要消费数值指标时还应检查所需字段实际存在且为有限数值，不能仅看进程退出码。该能力沿用 Evaluator CLI 和 Node.js SDK，不新增 HTTP 服务；Python 调用方可用子进程执行 CLI 后读取上述 JSON。报告重建从已保存 JSON 计算，不调用模型或再次运行 NPU。

```bash
# 使用 run 输出的结果目录；无需模型凭证或重新执行算子。
ember-evaluator report /absolute/path/to/results/run-id
# 沿用同一配置续跑；仍须设置配置引用的环境变量。
ember-evaluator run playbook/kernel/existing.yaml --resume
```

`--dry-run` 通过只表示配置和任务来源可解析，不检查 NPU 是否可用。实际 `run` 缺少 torch、torch_npu 或 NPU 时会返回非零退出码，并留下无效评测记录；不能据此判断候选算子的正确性。

## 独立测量原子

除完整 `run` 外，Evaluator 提供三个可单独调用的测量原子，供外部编排（如 RSI）或人工逐项使用：

```bash
# 精度门：多 seed 双跑，对照 problem.Model 参照（默认容差 atol=1e-5 / rtol=1e-3）
ember-evaluator kernel precision --problem <problem.py> --kernel <kernel.py> \
  --out <precision.json> [--seeds 0 1] [--python /usr/bin/python3]
# 纯计时：与基准走同一 timing 模块（口径见上文"指标与结果"），不校验精度
ember-evaluator kernel bench --problem <problem.py> --kernel <kernel.py> \
  --out <bench.json> [--warmup 25] [--repeat 100] [--python /usr/bin/python3]
# msprof 采集：attach 重放脚本采集硬件指标，带缓存与重试；roofline 分类一体返回
ember-evaluator kernel profile --problem <problem.py> --kernel <kernel.py> \
  --out <profile.json> [--round 0] [--seed 42] [--warmup 25] [--python /usr/bin/python3]
```

三个命令均支持 `--timeout-ms` 与 `--output-limit-bytes`。Bench/precision 默认总超时为 900000 ms；`--timeout-ms 0` 关闭该总超时。Profile 默认不另设总超时，`--max-attempts`（默认 2）与 `--attempt-timeout-seconds`（默认 300）分别控制采集尝试。Profile 还支持 `--retry-delay-ms`、`--cache-max-entries`、`--cleanup-grace-ms` 与 `--cleanup-timeout-ms`。

输出均为单份 JSON：

| 原子 | 输出字段 |
| --- | --- |
| `precision` | `passed`（bool）、`error`、`seeds`、`tolerance` |
| `bench` | `time_ms`（ms）、`error` |
| `profile` | `round`、`measured_by`、`metrics`（按 block 的管道利用率/L2/带宽表）、`trace_analysis`（流水线 trace 分析：最长核/overlap/空泡/Double Buffer，无 trace 数据时缺省）、`roofline`（`bottleneck`/`efficiency_rate`/各管道利用率/`warnings`）、`artifacts`、`error` |

roofline 判定：最高管道利用率低于 0.8 直接判 `no`（欠利用优先）；否则利用率不低于 0.4 的管道按 scalar→vec→mte2→mte3 顺序归类为瓶颈。

退出码契约：业务失败（候选编译不过、精度不过等）时 `error` 字段非空、`--out` 照常落盘、进程以 0 退出；解释器缺失、超时、被取消等执行环境故障以非零退出。环境旋钮：`--python` 缺省 `python`，NPU 环境应传带 torch_npu 的解释器；`KERNEL_ATOM_DIR` 可显式指定执行体目录（缺省从安装位置自动定位）。

多卡选卡：三个原子均支持 `--device <n>` 指定 NPU 逻辑卡号（缺省 0 卡），等价于在执行体环境设置 `KERNEL_NPU_DEVICE`；完整 `run` 则通过 `benchmark.config.device` 配置。目标卡须在 `ASCEND_RT_VISIBLE_DEVICES` 允许的可见集合内，`profile` 的采集缓存按可见卡集合与目标卡号区分，不同卡的证据不互换复用。

## 与 RSI 框架对接

RSI 的 `application.kernel` 封存候选源码，`proposer.operator` 生成改动，`evaluator.operatorbench` 通过完整 `Evaluator.run()` SDK 调用 kernel Benchmark 与 kernel-replay Solver。RSI 安装固定提交的 `ember-evaluator`，不查找相邻源码仓库，也不依赖单独的 CLI 桥接。评测和独立诊断是两个 SDK 操作。Measurement 证据链接原生结果与 verifier 产物；证据可用性及校准用于标记可信度，与候选生成区分。

SDK 拥有运行资产、依赖和 prepare/build 生命周期。契约与计时验证通过公共导出消费。独立安装包测试只能证明打包和软件链路，真实精度与性能仍须在 NPU 验证。
