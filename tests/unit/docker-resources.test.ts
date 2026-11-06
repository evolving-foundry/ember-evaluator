import { expect, test, vi } from "vitest";
import { assertDockerCapacity, readDockerCapacity } from "../../src/infrastructure/containers/resources.js";
import { classifyError } from "../../src/core/errors/classify.js";
import { failureDecision } from "../../src/core/policies/error-policy.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

test("Docker capacity rejects oversized tasks without declaring the node exhausted", async () => {
  const command = vi.fn<DockerCommand>().mockResolvedValue({ stdout: '{"NCPU":4,"MemTotal":8589934592}', stderr: "" });
  const capacity = await readDockerCapacity(command, new AbortController().signal);
  expect(() => assertDockerCapacity({ cpus: 4, memory: "8g" }, capacity)).not.toThrow();
  for (const resources of [{ cpus: 5 }, { memory: "8193m" }]) {
    try { assertDockerCapacity(resources, capacity); throw new Error("expected rejection"); }
    catch (error) {
      const failure = classifyError(error, { phase: "prepare", component: "environment" });
      expect(failure.code).toBe("ENV_RESOURCE_REQUIREMENTS_UNMET");
      expect(failureDecision(failure).action).toBe("finalize");
    }
  }
});
