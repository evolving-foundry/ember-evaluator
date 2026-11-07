import "../fixtures/network-fetch.js";
import { expect, test, vi } from "vitest";
import { DefinedBenchmark, type DatasetRecordSource, type JsonValue, type SourceLock } from "../../src/index.js";
import { gsm8kDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/gsm8k.js";
import { dropDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/drop.js";

const context = {
  model: { name: "unused", endpoint: null, provider: null, api: null },
  auth: { value: "", reference: null },
  dockerExecutable: "docker",
};
const usage = { inputTokens: null, outputTokens: null, totalTokens: null };

function memorySource(partitions: Record<string, JsonValue[]>): DatasetRecordSource {
  const lock: SourceLock = { source: "memory:fixture", revision: "fixture-v1", files: [], metadata: null };
  return {
    async resolve(previous, signal) {
      signal.throwIfAborted();
      if (previous && previous.source !== lock.source) throw new Error("Source identity changed");
      return structuredClone(previous ?? lock);
    },
    async *rows(_lock, selection, signal) {
      if (!partitions[selection]) throw new Error(`Unknown partition ${selection}`);
      for (const value of partitions[selection]) {
        signal.throwIfAborted();
        yield structuredClone(value);
      }
    },
  };
}

test("GSM8K conversion and scoring work with a non-HF source and keep answers private", async () => {
  const fetch = vi.fn(() => { throw new Error("Unexpected download"); });
  vi.stubGlobal("fetch", fetch);
  try {
    const source = memorySource({ test: [{ question: "How much is 6 times 7?", answer: "Six times seven. #### 42" }] });
    const benchmark = new DefinedBenchmark(gsm8kDefinition, source, context);
    const signal = new AbortController().signal;
    const lock = await benchmark.resolveSource(null, signal);
    const refs = [];
    for await (const ref of benchmark.enumerate(lock, signal)) refs.push(ref);
    expect(refs).toEqual([{ id: "test:0", recordKey: 0 }]);
    const prepared = await benchmark.prepare(refs[0]!, lock, signal);
    expect(prepared.input.prompt).toContain("How much is 6 times 7?");
    expect(JSON.stringify(prepared.input)).not.toContain("42");
    expect(prepared.verification).toMatchObject({ expected: "42" });
    expect(await benchmark.verify(prepared, { finalText: "#### 42", usage }, null, signal)).toMatchObject({ score: 1, passed: true });
    expect(await benchmark.verify(prepared, { finalText: "#### 41", usage }, null, signal)).toMatchObject({ score: 0, passed: false });

    const resumed = new DefinedBenchmark(gsm8kDefinition, source, context);
    expect(await resumed.resolveSource(lock, signal)).toEqual(lock);
    expect((await resumed.prepare(refs[0]!, lock, signal)).input).toEqual(prepared.input);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

test("source-independent setup reads training records without enumerating them as test tasks", async () => {
  const source = memorySource({
    train: [{ training: { passage: "Training passage", qa_pairs: Array.from({ length: 3 }, () => ({
      question: "Training question", answer: { spans: ["example"] },
    })) } }],
    test: [{ passage: { passage: "A cat is sleeping.", qa_pairs: [{ question: "Which animal is sleeping?", answer: { spans: ["cat"] } }] } }],
  });
  const benchmark = new DefinedBenchmark(dropDefinition, source, context);
  const signal = new AbortController().signal;
  const lock = await benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of benchmark.enumerate(lock, signal)) refs.push(ref);
  expect(refs).toHaveLength(1);
  const prepared = await benchmark.prepare(refs[0]!, lock, signal);
  expect(prepared.input.prompt).toContain("Training passage");
  expect(prepared.input.prompt).toContain("Which animal is sleeping?");
  expect(await benchmark.verify(prepared, { finalText: "cat", usage }, null, signal)).toMatchObject({ score: 1, passed: true });
});
