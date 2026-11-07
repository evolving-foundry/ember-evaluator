import { expect, test } from "vitest";
import { RayControl } from "../../src/infrastructure/ray/control.js";

test("Ray runtime handshake sends the independent Judge credential to a worker", async () => {
  const control = new RayControl({
    default: { model: { name: "solver", endpoint: "https://example.invalid/v1", api: "openai-completions", provider: null },
      auth: { value: "solver-secret", reference: "MODEL_API_KEY" } },
    judge: { model: { name: "judge", endpoint: "https://judge.invalid/v1", api: "openai-completions", provider: null },
      auth: { value: "judge-secret", reference: "JUDGE_MODEL_API_KEY" } },
  }, async () => {});
  const key = { runId: "run", taskId: "task", attemptId: "attempt" };
  const pluginVersions = { evaluator: "fixture" };
  control.register(key, "digest", pluginVersions);
  const runtime = await control.handle("runtime", {
    key,
    nodeId: "node",
    hostname: "host",
    packageDigest: "digest",
    pluginVersions,
  });
  expect(Object.keys(runtime as object)).toEqual(["services"]);
  expect(runtime).toMatchObject({
    services: { default: { auth: { value: "solver-secret", reference: null } }, judge: { model: { name: "judge" }, auth: { value: "judge-secret", reference: null } } },
  });
});
