# Scoring Rules and References

> English | [中文](./scoring.zh-CN.md)

Completion, score, binary correctness, and cleanup describe different facts. Quality score may be absent; passed:null means binary correctness was not measured and can coexist with continuous scores. Performance must use passed:null without score. Missing scores are not zeros; absent correctness does not justify invented pass thresholds.

## Record-Based Benchmark Scoring

This page records rules, references, pinned versions, and adaptations. Prompts, tool access, sample counts, data versions, and judges also affect scores. Full real-model comparisons against official runners have not been performed; do not publish these runs as officially comparable.

| Benchmark | Protocol | Result |
| --- | --- | --- |
| GSM8K | Original numeric exact match | Prompts require `#### 42`; extracts the first matching marked number, removing commas. Missing markers fail; arbitrary final lines are not answers |
| MMLU | mmlu-chat-logprobs-v1 | First five subject dev examples; test ends Answer:. Chat next-position A/B/C/D logprob argmax. score/passed compares the chosen option; no generated-letter parsing |
| MMLU-Pro | Original API version | Category validation CoT examples, `N/A` options removed; extract `answer is (X)`, then `Answer: X`, then the last standalone option letter |
| GPQA | simple-evals generative extraction | Seed 0 option permutation; extract `Answer: B` or `Answer: $B$`, without mixing the original author's alternate parser |
| MATH-500 | math500-simple-evals-v1 | Pinned prompts/full equivalence judge; first `Answer:` extraction, or `None` text as upstream. Lowercase/trim judge: only `yes` scores1, everything else0; request failure invalidates verification |
| MGSM | Multilingual simple-evals | Original language instructions/prefixes; numeric extraction after the last matching prefix; missing prefix0. Original dataset has no sole canonical extractor |
| TriviaQA | Original EM/F1 | Punctuation→spaces, article removal, no extra accent removal. Full response, best reference EM/token F1. score/passed=EM; details/quality-score.triviaqa also retain F1 |
| DROP | drop-official-annotations-v1 | Each annotation is one alternative containing all required spans; optimal one-to-one F1 alignment with Python rounding; passed=EM |
| HumanEval | Single pass@1 | Catches Python exceptions including SystemExit; requires normal completion marker, not exit 0 alone. Linux tests3 seconds, Docker attached process30 seconds |
| SimpleQA | simpleqa-simple-evals-v1 | Full pinned judge template; first A/B/C classification, unmatched=NOT_ATTEMPTED. score/passed=CORRECT; details retain class/raw response. Requests failing remain verification failures |
| HealthBench | healthbench-simple-evals-v1 | Full conversation/final response/weighted rubric per judge request. Satisfied positive/negative weights divided by positive sum; negative task scores possible; passed:null |
| OfficeQA Pro V2 | Pinned official script | Unmodified reward.py, default numerical tolerance0; see [OfficeQA](../benchmarks/officeqa-pro-v2.md) |

MATH-500/SimpleQA/HealthBench templates/parsers follow [OpenAI simple-evals652c89d](https://github.com/openai/simple-evals/tree/652c89d0ca9df547706735883097e9537d40dc47). Users choose judges. Invalid HealthBench output fails without unbounded retries. Solver inputs flatten original messages as text; judges retain message structure. Conditions may differ from official runners; evidence keeps `officialComparable`:false.

## References and Pinned Versions

| Benchmark | Reference implementation |
| --- | --- |
| GSM8K | [openai/grade-school-math 3101c7d：dataset.py](https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/grade_school_math/dataset.py) |
| MMLU | [hendrycks/test4450500 evaluate.py](https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py):5-shot,argmax,missing=-100,softmax; Chat differences below |
| MMLU-Pro | [TIGER-AI-Lab/MMLU-Pro f418b11：evaluate_from_api.py](https://github.com/TIGER-AI-Lab/MMLU-Pro/blob/f418b116db00b065c2aea046518d8fcf74d39872/evaluate_from_api.py) |
| GPQA | [simple-evals652c89d gpqa_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/gpqa_eval.py) and common.py |
| MATH-500 | [math_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/math_eval.py) and full common.py equivalence template |
| MGSM | [mgsm_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/mgsm_eval.py): multilingual instructions/prefixes/numeric rules |
| TriviaQA | [mandarjoshi90/triviaqa ca43b58：triviaqa_evaluation.py](https://github.com/mandarjoshi90/triviaqa/blob/ca43b5820b107f3970cf4b7d67f7db7a98117b79/evaluation/triviaqa_evaluation.py) |
| DROP | [AllenAI b1f3722 drop.py](https://github.com/allenai/allennlp-models/blob/b1f372248c17ad12684d344955fbcd98e957e77e/allennlp_models/rc/tools/drop.py); official ZIP SHA-256 `39d2278a29fd729de301b111a45f434c24834f40df8f4ff116d864589e3249d6` |
| HumanEval | [execution.py](https://github.com/openai/human-eval/blob/b9453e8f1865df0a0057a1383767caa400acfbcf/human_eval/execution.py): exception handling/3-second limit; adds Docker isolation/completion markers |
| SimpleQA | [simpleqa_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/simpleqa_eval.py), full judge template |
| HealthBench | [healthbench_eval.py](https://github.com/openai/simple-evals/blob/652c89d0ca9df547706735883097e9537d40dc47/healthbench_eval.py), full template/weights |
| OfficeQA Pro V2 | [reward.py](https://github.com/databricks/officeqa/blob/7b9a3c154ef9fb40215bb67934afc43e6799de16/reward.py), unchanged local copy |

OfficeQA `reward.py` SHA-256 is `0d91698c87df6d889339aac36f63ae0966607f169890b0bf8b472b26bfe8138f`. Full predictions go directly to `score_answer` for extraction/matching. Infrastructure failures produce no scores; answers are not packaged.

Copied templates retain [MIT licensing](../../../src/plugins/benchmarks/agent-harness/definitions/scoring/LICENSE-MIT). OfficeQA [Apache license](../../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/LICENSE-APACHE)/[NOTICE](../../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/NOTICE) remain beside scripts and ship in builds.

## MMLU Probability Scoring and Service Requirements

MMLU defaults to choice-logprobs/local, directly querying without agents/tools. Services must accept logprobs:true/top_logprobs and return `choices[0].logprobs.content[0]` token/logprob/nonempty candidates. Text-only/null/missing probabilities fail without `Answer: B` fallback.

Requests use `max_tokens: 1`,`temperature: 0`,stream:false. `benchmark.solver.config.topLogprobs` defaults 20, range 1–20. One-position requests override general maxTokens. No thinking switch is sent by default; configure `thinking: disabled` for reasoning-first services. Thinking tokens fail to avoid scoring reasoning probabilities. `services.<name>.retry.maxAttempts` defaults 4 including first; exhaustion reports networking without automatic task reruns.

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

Tokens such as ` B` and space-B group by trimmed uppercase letters; each choice uses maximum logprob, including known generated-token probability. Missing options use -100 as [original](https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py), recorded in missingChoices. Ties prefer A/B/C/D order; all-missing therefore chooses A with all omissions recorded, not evidence of valid probabilities for every option.

`choiceLogprobs` saves actual/fallback values; `choiceProbabilities` is softmax across four options, not full-vocabulary probabilities. Observations/evidence retain raw candidates, parameters, response model ID, and prompt SHA-256.

No old-context automatic cropping is reproduced. Overflow remains request failure without removing examples. Changed dev sources/prompts require new output directories. See [MMLU YAML](../../../playbook/mmlu/mmlu-simpleagent.yaml).

### Differences from Official MMLU

Original [evaluate.py](https://github.com/hendrycks/test/blob/4450500f923c49f1fb1dd3d99108a0bd9717b660/evaluate.py) used Text Completions,`max_tokens=1`,`temperature=0`,`logprobs=100`,echo=True. It chose maximum logprob for leading-space A/B/C/D tokens at the answer position.

The current gateway rejected Text Completions with HTTP 400/missing `messages`, so this project adapts Chat Completions:

- Pass subject5-shot prompts through messages.
- Set `max_tokens=1`,`temperature=0`,`logprobs=true`,top_logprobs=20.
- Extract A/B/C/D from first-position candidates and take maximum logprob.
- Do not score through regex on free-generated text.

**Main differences:**

1. **API**: Text versus Chat Completions; message templates may affect context.
2. **Candidate count**:100 officially versus at most20 through Chat, potentially missing options.
3. **Token matching**: Official leading spaces versus support for different returned whitespace.
4. **Context**: No legacy-window few-shot cropping.
5. **Prompt**: Adds `Answer with exactly one letter: A, B, C, or D.` and `Do not provide an explanation.` between options and Answer:. Dev examples remain unchanged. This stabilizes first-letter output/candidate coverage but deviates from original prompts.

The core **5-shot + option-logprob argmax + accuracy** method remains, without guaranteed identical official results.

Results identify `mmlu-chat-logprobs-v1` and `officialComparable: false` to distinguish the Chat adaptation.

## DROP Annotations and Multiple Spans

DROP reads official [AllenAI ZIP](https://s3-us-west-2.amazonaws.com/allennlp/datasets/drop/drop_dataset.zip) train/dev, evaluating dev. Cache/locks validate pinned SHA-256 and retain answer/validated_answers grouping. For [Alice,Bob], Alice alone yields F1=.5/EM0; both are needed for full credit. Complete annotations remain alternatives, never concatenated.

Prompts request `Answer:` with JSON string arrays for multiple spans and training Q/A examples. `benchmark.config` accepts `cacheDir` only, default `.cache/drop`, without HF tokens. Old locks/order require new runs. Other scoring/prompt changes also require separate runs.

## Independent Judges

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

Judges never bind automatically to evaluated models. Explicit default reuse is saved in configuration/evidence. Authentication is excluded; verdict.details keeps judge/protocol identity, prompt hashes, and explanations.

MATH-500 requires benchmark.config.judgeService. Profiles default to `judge`; see [full YAML](../../../playbook/math500/math500-simpleagent.yaml). Migration from deterministic scoring adds model/endpoint/authentication `services.judge` and a new output directory.

Every valid MATH-500 response calls the equivalence judge, even text-identical answers. Rules permit simple specified transformations, without guaranteeing arbitrary equivalence. Judge models/parameters affect results. `Yes.` or explained `Yes, ...` scores0; only case/outer whitespace around `yes` is ignored. Failed/truncated calls never become valid zeros.

HealthBench requires no extra fixed reply cap. Without `maxTokens`, explicit Chat Solver/Judge requests omit token caps; server decides. Explicit caps remain effective. Truncation/invalid judge output/call failures remain failures. `parameters.maxTokens:null` and `outputLimit:provider-default` mean no client cap was sent.

Partial HealthBench failure retains completed grades and `failedRubric` index/criterion/weight/raw output (null on call failure)/cause, plus judge identity/attempted prompt hashes, with credentials redacted. verdict has no score, passed:null, scoreStatus:invalid. Timeout/cancellation retain execution status; offline metrics exclude scores and resume reruns the task.

## Metric Denominators

quality-score mean/rawMean use valid measured scores; measured reports coverage. HealthBench clamps overall mean to[0,1] while retaining raw mean. SimpleQA separately aggregates classes, unattempted rate, attempted accuracy, and F1.

success-rate excludes verified passed:null samples from correctness denominators. With no binary judgments it returns applicable:false/empty denominator. Other quality tasks conservatively use selected minus explicitly invalid; pending keeps reports incomplete. Agent timeouts are valid zeros; judge/infrastructure timeouts are not wrong answers.

Performance has no quality denominator. Completeness, request error rate, and comparability are separate. Engine wall time/warmup/cleanup are outside request timing; see [AgentX](../benchmarks/agentx.md).

[User guide](../README.md) · [Quick start](../quick-start.md)
