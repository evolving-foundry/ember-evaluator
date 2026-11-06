import "../fixtures/network-fetch.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { expect, test, vi } from "vitest";
import { apply as registerEvaluator } from "../../src/application/plugins/registry.js";
import * as builtins from "../../src/plugins/index.js";
import { DefinedBenchmark } from "../../src/plugins/benchmarks/agent-harness/definitions/defined-benchmark.js";
import { completeJudge } from "../../src/infrastructure/models/judge.js";

vi.mock("../../src/infrastructure/models/judge.js", () => ({ completeJudge: vi.fn() }));

test("DefinedBenchmark loads locked JSONL tasks, scores answers, and resumes from cache", async () => {
  vi.stubEnv("HF_ENDPOINT", "https://hf-mirror.com");
  const root = await mkdtemp(join(tmpdir(), "evaluator-huggingface-"));
  const context = new Context();
  const revision = "a".repeat(40);
  const datasetPath = "test.jsonl";
  const rows = [
    { problem: "What is six times seven?", answer: "42" },
    { problem: "What is two plus three?", answer: "5" },
  ];
  const bytes = Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const metadataUrl = "https://hf-mirror.com/api/datasets/HuggingFaceH4/MATH-500/revision/main?blobs=true";
  const fileUrl = `https://hf-mirror.com/datasets/HuggingFaceH4/MATH-500/resolve/${revision}/${datasetPath}`;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = String(input);
    if (url === metadataUrl) return new Response(JSON.stringify({ sha: revision, siblings: [{ rfilename: datasetPath }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    if (url === fileUrl) return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
    return new Response("Unexpected Hugging Face request", { status: 404 });
  });
  try {
    await context.plugin(registerEvaluator);
    await context.plugin(builtins);
    const model = { name: "unused", endpoint: null, provider: null, api: null };
    const auth = { value: "", reference: null };
    const runtime = {
      model,
      auth,
      services: { default: { model, auth }, judge: { model, auth } },
      solverService: "default",
      configDirectory: root,
      resolvePath(path: string) { return join(root, path); },
    };
    const selection = { name: "math500", config: { cacheDir: "dataset-cache", judgeService: "judge" } };
    const benchmark = await context.evaluator.create("benchmark", selection, runtime);
    expect(benchmark).toBeInstanceOf(DefinedBenchmark);

    const signal = new AbortController().signal;
    const lock = await benchmark.resolveSource(null, signal);
    expect(lock.revision).toBe(revision);
    expect(lock.files).toEqual([expect.objectContaining({ path: datasetPath, origin: fileUrl, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    const refs = [];
    for await (const ref of benchmark.enumerate(lock, signal)) refs.push(ref);
    expect(refs).toEqual([{ id: "test:0", recordKey: 0 }, { id: "test:1", recordKey: 1 }]);

    const prepared = await benchmark.prepare(refs[0]!, lock, signal);
    expect(prepared.input).toEqual({
      id: "test:0",
      prompt: "Solve the following math problem step by step. The last line of your response should be of the form Answer: $ANSWER (without quotes) where $ANSWER is the answer to the problem.\n\nWhat is six times seven?\n\nRemember to put your answer on its own line after \"Answer:\", and you do not need to use a \\boxed command.",
    });
    expect(JSON.stringify(prepared.input)).not.toContain("42");
    expect(prepared.verification).toEqual({ kind: "math", expected: "42" });
    const usage = { inputTokens: null, outputTokens: null, totalTokens: null };
    vi.mocked(completeJudge).mockResolvedValueOnce("Yes").mockResolvedValueOnce("No");
    expect(await benchmark.verify(prepared, { finalText: "Answer: 42", usage }, null, signal)).toMatchObject({ passed: true, score: 1 });
    const wrong = await benchmark.verify(prepared, { finalText: "Answer: 41", usage }, null, signal);
    expect(wrong).toMatchObject({ passed: false, score: 0 });
    expect(wrong.details).not.toHaveProperty("expected");

    vi.stubGlobal("fetch", () => { throw new Error("Resume unexpectedly requested remote data"); });
    const resumed = await context.evaluator.create("benchmark", selection, runtime);
    expect(await resumed.resolveSource(lock, signal)).toEqual(lock);
    expect((await resumed.prepare(refs[1]!, lock, signal)).input.prompt).toContain("What is two plus three?");
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await context.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
