import type { DatasetFilesDefinition } from "../../../../infrastructure/datasets/sources/huggingface/files-source.js";
import type { BenchmarkDefinition } from "./benchmark-definition.js";
import { gsm8kDefinition } from "./gsm8k.js";
import { mmluDefinition } from "./mmlu.js";
import { mmluProDefinition } from "./mmlu-pro.js";
import { math500Definition } from "./math500.js";
import { gpqaDefinition } from "./gpqa.js";
import { mgsmDefinition } from "./mgsm.js";
import { triviaqaDefinition } from "./triviaqa.js";
import { humanevalDefinition } from "./humaneval.js";
import { simpleqaDefinition } from "./simpleqa.js";
import { healthbenchDefinition } from "./healthbench.js";

/** Built-in composition: record interpretation is independent of its download adapter. */
export const DEFINED_BENCHMARKS: readonly { definition: BenchmarkDefinition; source: DatasetFilesDefinition }[] = [
  {
    definition: gsm8kDefinition,
    source: {
      dataset: "openai/gsm8k",
      revision: "main",
      selections: [{ key: "test", prefix: "main/test-", format: "parquet" }],
    },
  },
  {
    definition: mmluDefinition,
    source: {
      dataset: "cais/mmlu",
      revision: "main",
      selections: [
        { key: "test", prefix: "all/test-", format: "parquet" },
        { key: "dev", prefix: "all/dev-", format: "parquet" },
      ],
    },
  },
  {
    definition: mmluProDefinition,
    source: {
      dataset: "TIGER-Lab/MMLU-Pro",
      revision: "main",
      selections: [
        { key: "test", prefix: "data/test-", format: "parquet" },
        { key: "validation", prefix: "data/validation-", format: "parquet" },
      ],
    },
  },
  {
    definition: math500Definition,
    source: {
      dataset: "HuggingFaceH4/MATH-500",
      revision: "main",
      selections: [{ key: "test", path: "test.jsonl", format: "jsonl" }],
    },
  },
  {
    definition: gpqaDefinition,
    source: {
      dataset: "Idavidrein/gpqa",
      revision: "main",
      selections: [{ key: "test", path: "gpqa_diamond.csv", format: "csv" }],
    },
  },
  {
    definition: mgsmDefinition,
    source: {
      dataset: "juletxara/mgsm",
      revision: "main",
      selections: mgsmDefinition.selections.map(language => ({ key: language, prefix: `${language}/test-`, format: "parquet" })),
    },
  },
  {
    definition: triviaqaDefinition,
    source: {
      dataset: "mandarjoshi/trivia_qa",
      revision: "main",
      selections: [{ key: "test", prefix: "rc.nocontext/validation-", format: "parquet" }],
    },
  },
  {
    definition: humanevalDefinition,
    source: {
      dataset: "openai/openai_humaneval",
      revision: "main",
      selections: [{ key: "test", prefix: "openai_humaneval/test-", format: "parquet" }],
    },
  },
  {
    definition: simpleqaDefinition,
    source: {
      dataset: "basicv8vc/SimpleQA",
      revision: "main",
      selections: [{ key: "test", path: "simple_qa_test_set.csv", format: "csv" }],
    },
  },
  {
    definition: healthbenchDefinition,
    source: {
      dataset: "openai/healthbench",
      revision: "main",
      selections: [{ key: "test", path: "2025-05-07-06-14-12_oss_eval.jsonl", format: "jsonl" }],
    },
  },
];
