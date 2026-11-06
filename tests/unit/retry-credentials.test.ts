import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { retryRun } from "../../src/application/retry.js";

test.each(["solver", "verifier", "benchmark-judge"])("retry rejects runtime-only %s authentication before admitting an Attempt", async role => {
  const root = await mkdtemp(join(tmpdir(), "retry-credentials-"));
  try {
    const saved = {
      services: { default: { apiKey: role === "solver" ? "[runtime-provided]" : "${KEY}" }, judge: { apiKey: "[runtime-provided]" } },
      solver: { service: "default" },
      ...(role === "verifier" ? { verifier: { service: "judge" } } : {}),
      benchmark: { config: role === "benchmark-judge" ? { judgeService: "judge" } : {} },
    };
    await writeFile(join(root, "config.yaml"), JSON.stringify(saved));
    await expect(retryRun({ run: root, taskIds: [] }, new AbortController().signal, () => {}))
      .rejects.toThrow(/runtime-only credential/);
    expect(await readdir(root)).toEqual(["config.yaml"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
