import { expect, test } from "vitest";
import { dockerImageName } from "../../src/infrastructure/containers/image-name.js";

test("image names expose task, purpose and kind and stay stable across runs", () => {
  const scope = { taskId: "terminal-bench/atrx-vep-crispr", phase: "solve" as const };
  const name = dockerImageName("runtime", "same-content", scope);
  expect(name).toMatch(/^ember-evaluator\/atrx-vep-crispr:solve-runtime-[a-f0-9]{24}$/u);
  expect(dockerImageName("runtime", "same-content", scope)).toBe(name);
  expect(dockerImageName("runtime", "new-content", scope)).not.toBe(name);
  expect(dockerImageName("runtime", "same-content", { ...scope, phase: "verify" }))
    .toMatch(/^ember-evaluator\/atrx-vep-crispr:verify-runtime-[a-f0-9]{24}$/u);
  expect(dockerImageName("solver-install", "shared"))
    .toMatch(/^ember-evaluator\/shared:solver-install-[a-f0-9]{24}$/u);
});

test("full task and service IDs disambiguate normalized and truncated names", () => {
  const names = ["benchmark-a/Task A", "benchmark-b/Task A", "benchmark-a/task-a"].map(taskId =>
    dockerImageName("base", "content", { taskId, phase: "solve" }));
  expect(names.every(name => name.startsWith("ember-evaluator/task-a:solve-base-"))).toBe(true);
  expect(new Set(names).size).toBe(3);
  const scope = { taskId: "题目", phase: "verify" as const, service: "Redis_1" };
  expect(dockerImageName("base", "content", scope))
    .toMatch(/^ember-evaluator\/task:verify-service-redis-1-base-[a-f0-9]{24}$/u);
  expect(dockerImageName("base", "content", { ...scope, service: "redis-1" }))
    .not.toBe(dockerImageName("base", "content", scope));
  const long = dockerImageName("agent-base", "content", { taskId: "a".repeat(1000), phase: "verify", service: "b".repeat(1000) });
  expect(long.split(":")[0]!.length).toBeLessThanOrEqual(255);
  expect(long.split(":")[1]!.length).toBeLessThanOrEqual(128);
});
