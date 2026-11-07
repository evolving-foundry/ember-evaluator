# 评分规则与参考

> [English](./scoring.md) | 中文

执行完成、分数、二元正确性和资源清理表达不同事实。质量结果的 score 可缺省；passed:null 表示没有测量二元正确性，可以同时有连续分数。性能结果必须 passed:null 且不含 score。无分数不能补为零，无正确性不能虚构通过阈值。

## 记录型 Benchmark 评分

本页集中记录评分规则、参考实现、固定版本与适配差异。模型提示词、工具权限、采样次数、数据版本及裁判模型也会影响最终成绩。尚未进行真实模型与官方完整评测的对照，不应将这些运行直接发布为官方可比成绩。

| Benchmark | 协议 | 结果 |
| --- | --- | --- |
| GSM8K | 原作者数值 exact match | 提示词要求最终答案使用 `#### 42`，提取第一个符合规则的 `#### ` 数值并去除逗号。缺少标记不算正确，不再把任意末行当作答案。 |
| MMLU | mmlu-chat-logprobs-v1 | 同科目前 5 道 dev 题作为示例，以 `Answer:` 结束测试题；通过 Chat 接口获取下一个输出位置的候选 logprobs，按 A/B/C/D 最大值选答案。score/passed 表示与标准选项是否相同，不解析生成的字母。 |
| MMLU-Pro | 原作者 API 版本 | 使用同类别 validation CoT 示例，删除 `N/A` 占位选项；依次提取 `answer is (X)`、`Answer: X`、最后一个独立选项字母。 |
| GPQA | simple-evals 生成式提取 | 使用 seed 0 的选项抽样排列；按 `Answer: B` 或 `Answer: $B$` 提取，不混入原作者另一套回答解析器。 |
| MATH-500 | math500-simple-evals-v1 | 使用固定 simple-evals 的题目提示词和完整等价裁判模板；提取第一个 `Answer:` 后的答案，缺失时按上游向裁判传入 `None` 文本。裁判回复转小写、去除首尾空白后仅 `yes` 得 1 分，其余得 0 分；请求失败属于验证失败。 |
| MGSM | simple-evals 多语言版本 | 使用各语言原始指令和答案前缀，仅从最后一个对应前缀之后提取数字；没有前缀得零分。原作者数据仓库没有唯一的回答提取器。 |
| TriviaQA | 原作者 EM/F1 | 标点替换为空格后再去冠词，不做额外去音调处理；使用完整回答，对候选参考分别取最高 EM 和 token F1。score/passed 表示 EM，details 和 quality-score.triviaqa 另存 F1。 |
| DROP | drop-official-annotations-v1 | 每份官方标注为一个候选，保留候选内的多个必答 span；按最优一对一对齐计算 F1，舍入遵循 Python；passed 表示 EM。 |
| HumanEval | 单次 pass@1 | 捕获包含 SystemExit 在内的 Python 异常，要求测试正常结束并返回完成标记；容器退出码 0 本身不足以通过。测试在 Linux 容器内限时 3 秒，Docker 附加进程另有 30 秒上限。 |
| SimpleQA | simpleqa-simple-evals-v1 | 使用固定版本完整裁判模板，按首个 A/B/C 分类；无匹配按上游记 NOT_ATTEMPTED。score/passed 表示 CORRECT，details 保留分类和裁判原文。请求失败仍属验证失败。 |
| HealthBench | healthbench-simple-evals-v1 | 使用固定版本完整裁判模板；把完整对话、最终回复和带权重的单条 rubric 交给 Judge。满足条件计入正/负权重，除以正权重总和；单题可为负，passed:null。 |
| OfficeQA Pro V2 | 固定上游评分脚本 | 使用未经修改的官方 reward.py，默认数值容差为 0；详见 [OfficeQA 指南](../benchmarks/officeqa-pro-v2.zh-CN.md)。 |

MATH-500、SimpleQA、HealthBench 的模板与裁判解析规则依据固定的 [OpenAI simple-evals 652c89d](https://github.com/openai/simple-evals/tree/652c89d0ca9df547706735883097e9537d40dc47)。Judge 由用户选择，HealthBench 的非法裁判输出保留为验证失败，不无限重试；HealthBench 的求解输入仍是由原始消息拼成的文本，裁判读取的对话保留各条消息。这些条件与原版运行器可能不同，证据中的 `officialComparable` 保持 false。

## 评分参考与固定版本

| Benchmark | 参考实现 |
| --- | --- |
| GSM8K | [openai/grade-school-math 3101c7d：dataset.py](https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/grade_school_math/dataset.py) |
| MMLU | [hendrycks/test 4450500：evaluate.py](https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py)，采用其中的 5-shot 格式、argmax、缺失项 -100 和 softmax；Chat 适配差异见下文 |
| MMLU-Pro | [TIGER-AI-Lab/MMLU-Pro f418b11：evaluate_from_api.py](https://github.com/TIGER-AI-Lab/MMLU-Pro/blob/f418b116db00b065c2aea046518d8fcf74d39872/evaluate_from_api.py) |
| GPQA | [OpenAI simple-evals 652c89d：gpqa_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/gpqa_eval.py) 及同版本 common.py |
| MATH-500 | [OpenAI simple-evals 652c89d：math_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/math_eval.py) 及同版本 common.py 中的完整等价裁判模板 |
| MGSM | [OpenAI simple-evals 652c89d：mgsm_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/mgsm_eval.py)，采用多语言指令、答案前缀与数值提取规则 |
| TriviaQA | [mandarjoshi90/triviaqa ca43b58：triviaqa_evaluation.py](https://github.com/mandarjoshi90/triviaqa/blob/ca43b5820b107f3970cf4b7d67f7db7a98117b79/evaluation/triviaqa_evaluation.py) |
| DROP | [AllenAI b1f3722：drop.py](https://github.com/allenai/allennlp-models/blob/b1f372248c17ad12684d344955fbcd98e957e77e/allennlp_models/rc/tools/drop.py)；官方原始 ZIP SHA-256 为 `39d2278a29fd729de301b111a45f434c24834f40df8f4ff116d864589e3249d6` |
| HumanEval | [openai/human-eval b9453e8：execution.py](https://github.com/openai/human-eval/blob/b9453e8f1865df0a0057a1383767caa400acfbcf/human_eval/execution.py)，参考异常处理和 3 秒测试时限；本项目另外使用 Docker 隔离和完成标记 |
| SimpleQA | [OpenAI simple-evals 652c89d：simpleqa_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/simpleqa_eval.py) 中的完整裁判模板 |
| HealthBench | [OpenAI simple-evals 652c89d：healthbench_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/healthbench_eval.py) 中的完整裁判模板和权重计算 |
| OfficeQA Pro V2 | [databricks/officeqa 7b9a3c1：reward.py](https://github.com/databricks/officeqa/blob/7b9a3c154ef9fb40215bb67934afc43e6799de16/reward.py)，本地副本未经修改 |

OfficeQA `reward.py` 的 SHA-256 为 `0d91698c87df6d889339aac36f63ae0966607f169890b0bf8b472b26bfe8138f`。运行时将完整预测直接传给 `score_answer`，最终答案提取与匹配由原始脚本执行；基础设施失败不产生分数，题库答案不随程序包分发。

复制模板的 MIT 许可保存在 [LICENSE-MIT](../../../src/plugins/benchmarks/agent-harness/definitions/scoring/LICENSE-MIT)。OfficeQA 的原始 [LICENSE-APACHE](../../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/LICENSE-APACHE) 和 [NOTICE](../../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/NOTICE) 保留在评分脚本旁，并随构建打包。

## MMLU 概率评分与服务要求

MMLU 默认使用 `choice-logprobs` Solver 和 `local` 环境，直接请求模型，不经过 Agent 或工具。服务必须支持 OpenAI Chat Completions 请求中的 `logprobs: true`、`top_logprobs`，并实际返回 `choices[0].logprobs.content[0]` 的 `token`、`logprob` 和非空 `top_logprobs` 候选列表。只有生成文本、返回 null 或缺少概率字段均不能评分，会记为失败；不回退到解析 `Answer: B`。

每题请求 `max_tokens: 1`、`temperature: 0`、`stream: false`，候选数量由 `benchmark.solver.config.topLogprobs` 控制，默认 20，范围 1–20。此任务固定只请求一个输出位置，优先于服务中通用的 maxTokens 配置。默认不发送思考开关；服务若默认先思考，需要像示例一样配置 `thinking: disabled`。收到思考 token 会报错，避免把思考过程的概率当成答案概率。该 Solver 按 `services.<名称>.retry.maxAttempts` 重试单次模型请求，缺省最多 4 次（含首次）；耗尽后报告网络错误，不自动重新执行任务。

```yaml
benchmark:
  name: mmlu
  solver:
    name: choice-logprobs
    config:
      topLogprobs: 20
      thinking: disabled
environment: local
```

同一选项可能对应 `B`、` B` 等 token，本适配按去除首尾空白后的大写字母分组，取该组选项的最大 logprob；生成 token 本身的已知 logprob 也参与比较。没有出现在返回概率中的选项按[原作者脚本](https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py)使用 -100，`missingChoices` 保存缺失项。平局取 A/B/C/D 中最靠前的选项。因此所有选项都缺失时仍会按原脚本选 A，结果会明确列出全部缺失项；这类结果不代表模型对四个选项都提供了有效概率。

`choiceLogprobs` 保存四个选项的实际值或 fallback，`choiceProbabilities` 保存四个选项间的 softmax，而不是 token 在完整词表中的概率。原始候选、请求参数、响应模型标识和提示词 SHA-256 保存在 Solver observations，并进入评分证据。

不复现旧模型上下文窗口的自动 crop；超限时保留为请求失败，不擅自减少示例。增加 dev 来源文件或调整提示后，旧 MMLU 运行必须新建结果目录。完整 YAML 见 [MMLU 概率评分示例](../../../playbook/mmlu/mmlu-simpleagent.yaml)。

### MMLU 评分协议与官方实现的差异

原始 MMLU 评测脚本（[hendrycks/test/evaluate.py](https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py)）使用旧式 OpenAI Text Completions API，参数为 `max_tokens=1`、`temperature=0`、`logprobs=100`、`echo=True`。评分时读取答案位置 `" A"`、`" B"`、`" C"`、`" D"` 四个 token 的 logprob，选择概率最大的选项。

由于当前使用的模型网关不支持旧式 Text Completions 接口（实测返回 HTTP 400，提示缺少 `messages`），本项目采用 OpenAI 兼容的 Chat Completions API 适配实现：

- 使用 `messages` 传入同学科 5-shot MMLU 提示词。
- 设置 `max_tokens=1`、`temperature=0`、`logprobs=true`、`top_logprobs=20`。
- 从首个输出位置的候选 token 概率中提取 A/B/C/D，按最大 logprob 判定答案。
- 不使用自由生成文本后的正则解析作为评分依据。

**与官方实现的主要差异：**

1. **API 协议不同**：官方使用 Text Completions，本项目使用 Chat Completions；消息模板可能影响模型实际接收的上下文。
2. **候选数量不同**：官方请求 100 个候选，本项目受 Chat API 限制，最多请求 20 个候选。部分选项可能因此无法获取概率。
3. **Token 匹配不同**：官方匹配带前导空格的选项 token，本项目兼容 Chat 模型返回的不同空白写法。
4. **上下文处理不同**：当前实现不复现官方脚本针对旧模型上下文窗口的 few-shot 裁剪逻辑。
5. **提示词不同**：评分题在选项与 `Answer:` 之间加入 `Answer with exactly one letter: A, B, C, or D.` 和 `Do not provide an explanation.` 两行指令，五个 dev 示例保持原样；这条指令用于让首个输出 token 稳定为选项字母、并提高四个选项同时出现在候选中的比例，属于对原始提示的偏离。

因此，本项目保留了原始 MMLU 的 **5-shot + 选项 logprob argmax + Accuracy** 核心评分方法，但不能保证与官方脚本得到完全相同的结果。

评测结果使用协议标识 `mmlu-chat-logprobs-v1`，并设置 `officialComparable: false`，以区分原始官方协议与当前 Chat API 适配协议。

## DROP 原始标注与多 span

DROP 从 [AllenAI 官方原始 ZIP](https://s3-us-west-2.amazonaws.com/allennlp/datasets/drop/drop_dataset.zip)读取 train/dev，以 dev 作为评测题目。下载缓存与来源锁校验固定 SHA-256，保留 `answer` 和每份 `validated_answers` 的分组。例如参考为 `["Alice", "Bob"]` 时，仅回答 Alice 的 F1 为 0.5，EM 为 0；同时答出两个名字才能得到满分。不同标注者的完整答案仍是替代候选，不会互相拼接。

DROP 提示词要求使用 `Answer:`，多个 span 用 JSON 字符串数组表示，并提供包含问题和答案的训练示例。`benchmark.config` 仅接受 `cacheDir`，默认 `.cache/drop`；不需要 Hugging Face token。旧 DROP 来源锁和题目顺序不能续用，应新建运行目录。其他评分规则或提示词变化后，也应新建运行，避免混合修复前后的结果。

## 独立 Judge

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
  judge:
    model: ${JUDGE_NAME}
    base_url: ${JUDGE_ENDPOINT}
    api_key: ${JUDGE_API_KEY}
benchmark:
  name: healthbench
  config:
    judgeService: judge
```

Judge 不自动绑定被测模型。可以显式填写 default 复用同一服务，但该选择会进入保存配置和结果证据。认证值不会写入结果；裁判模型/协议身份、Prompt 哈希及解释保存在 verdict.details 中。

MATH-500 同样必须通过 `benchmark.config.judgeService` 指定服务。内置 Profile 默认指向名为 `judge` 的服务；完整示例见 [MATH-500 全量配置](../../../playbook/math500/math500-simpleagent.yaml)。从旧的确定性评分方式迁移时，需要增加 `services.judge` 的模型、地址和认证配置，并新建运行目录。

MATH-500 的每份有效模型回答都会触发等价裁判请求，即使答案与参考文本完全相同，也不通过本地比较提前给分。规则只要求裁判执行提示词中允许的简单等价变换，不保证识别任意数学等价式；裁判模型和参数不同仍可能影响成绩。`Yes.`、附带解释的 `Yes, ...` 或其他文本均按上游得零分，只有 `yes` 的大小写与首尾空白不影响判断。请求失败或截断不会伪装成正常的零分。

HealthBench 评分协议不要求本项目额外设置固定回复上限。上例未配置 `maxTokens`，显式 Chat Completions 服务的 Solver/Judge 请求均不发送输出 token 上限，由服务端决定。显式填写上限时仍会生效；服务端截断、非法 Judge 输出与调用失败均保留为失败，不伪装为合法得分。证据中的 `parameters.maxTokens:null` 与 `outputLimit:provider-default` 表示本次未发送客户端上限。

HealthBench 中途失败时，`verdict.details.grades` 保留已完成的逐项判断，`failedRubric` 记录失败项索引、criterion、权重、原始裁判输出（调用失败时为 null）和错误原因；同时保留裁判身份与已尝试 Prompt 的哈希。认证值会脱敏。该 verdict 没有 score，passed 为 null，评分状态为 invalid；超时或取消沿用执行状态，离线指标不计入评分，续跑会重新执行该题。

## 指标分母

quality-score 的 mean/rawMean 只基于有测量分数的有效结果，measured 明确给出覆盖数；HealthBench 对整体平均值截断到 [0,1]，原始平均值保留。SimpleQA 分类计数、未尝试率、已尝试正确率与 F1 分别汇总。

success-rate 不把 passed:null 的已验证样本计入正确率分母；全部样本都未测二元正确性时返回 applicable:false 和空分母。其他质量任务沿用所选任务扣除明确无效评测的保守分母，pending 会使报告保持未完成。Agent 解题超时按执行规则记有效零分；Judge/基础设施超时不是模型答错。

性能报告不计算质量分母。测量完整、请求错误率和可比性分别报告；Engine 总耗时、预热和清理不属于请求性能计时，详情见 [AgentX](../benchmarks/agentx.zh-CN.md)。

[返回用户手册](../README.zh-CN.md) · [快速上手](../quick-start.zh-CN.md)
