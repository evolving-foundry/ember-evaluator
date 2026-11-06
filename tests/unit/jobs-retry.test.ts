import { beforeEach, expect, test, vi } from "vitest";
import { RayJobsDeployment } from "../../src/application/ray/deployment.js";
const remote = vi.hoisted(() => ({ call: vi.fn(), attach: vi.fn() }));
vi.mock("../../src/infrastructure/ray/jobs-client.js", () => ({ JobsClient: { create: async () => remote } }));
beforeEach(() => vi.clearAllMocks());
const model = { name: "fixture", endpoint: null, api: "openai-completions", provider: null };
function scheduler() {
  return new RayJobsDeployment({ transport: "jobs", endpoint: "https://gateway.test", caFile: "ca.pem", tokenEnv: "JOBS_TOKEN" }, {
    services: { default: { model, auth: { value: "secret", reference: "MODEL_KEY" } } },
    solverService: "default", configDirectory: "/experiment", resolvePath: value => value,
  });
}
test("active Jobs retry targets the original gateway coordinator and does not submit a new experiment", async () => {
  remote.call.mockResolvedValue({ requestId: "request-1", status: "pending" });
  const log = vi.fn();
  expect(await scheduler().retryExperiment("run-id", "job-id", { taskIds: ["task-a"], requestId: "request-1", pluginVersions: { fixture: "1" }, signal: new AbortController().signal, log })).toBe(0);
  expect(remote.call).toHaveBeenCalledTimes(1);
  expect(remote.call.mock.calls[0]?.slice(0, 2)).toEqual(["/jobs/job-id/retry", { runId: "run-id", taskIds: ["task-a"], requestId: "request-1", reason: undefined, pluginVersions: { fixture: "1" }, serviceAuth: { default: "secret" } }]);
  expect(remote.attach).not.toHaveBeenCalled(); expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
});
test("terminal Jobs recovery follows the recovery process while keeping the original run identity", async () => {
  remote.call.mockResolvedValue({ requestId: "request-1", status: "submitted", recoveryJobId: "recovery-job" }); remote.attach.mockResolvedValue(0);
  const signal = new AbortController().signal; const log = vi.fn();
  expect(await scheduler().retryExperiment("original-run", "original-job", { taskIds: [], requestId: "request-1", pluginVersions: {}, signal, log })).toBe(0);
  expect(remote.attach).toHaveBeenCalledWith("recovery-job", log, signal);
  expect(remote.call.mock.calls[0]?.[1].runId).toBe("original-run");
});

test("a missing Jobs receipt exposes the generated request ID for safe replay", async () => {
  remote.call.mockRejectedValue(new Error("gateway connection closed"));
  const result = scheduler().retryExperiment("run-id", "job-id", { taskIds: [], pluginVersions: {}, signal: new AbortController().signal, log() {} });
  await expect(result).rejects.toThrow("Resubmit the same request ID");
  const request = remote.call.mock.calls[0]?.[1] as { requestId: string };
  await expect(result).rejects.toThrow(request.requestId);
  expect(remote.attach).not.toHaveBeenCalled();
});
