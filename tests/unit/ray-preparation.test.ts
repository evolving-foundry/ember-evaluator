import { expect, test, vi } from "vitest";
import { RayControl } from "../../src/infrastructure/ray/control.js";
import { validateRemoteJob } from "../../src/infrastructure/ray/protocol.js";

const key = { runId: "run", taskId: "task", attemptId: "preparation" };
const versions = { fixture: "1" };
const job = {
  schemaVersion: 2,
  job: { ...key, ref: { id: "task", recordKey: 1 }, configFingerprint: "config" },
  source: { source: "fixture", revision: "1", files: [], metadata: {} },
  safeConfig: { benchmark: { name: "fixture", config: {} }, environment: { name: "local", config: {} },
    solver: { name: "fixture", config: {}, service: "default" }, timeoutSeconds: 60 },
  pluginVersions: versions, packageDigest: `sha256:${"a".repeat(64)}`,
  uploadEndpoint: "https://collector.invalid", previousAttempts: [],
  preparation: { concurrency: 2, defaultTimeoutSeconds: 600, environmentTimeoutSeconds: null, roundId: "round", nodeId: "node", deadlineAt: "2026-10-01T00:00:00.000Z", mode: "prepare", digest: null },
};

test("preparation control grants runtime without recording an executing attempt", async () => {
  const update = vi.fn(async () => {});
  const control = new RayControl({ default: { model: { name: "fixture", api: "openai-completions", provider: null, endpoint: null },
    auth: { value: "fixture-secret", reference: null } } }, update);
  control.register(key, "digest", versions, true);
  const runtime = await control.handle("runtime", { key, nodeId: "node", hostname: "host", packageDigest: "digest", pluginVersions: versions });
  expect(runtime).toMatchObject({ services: { default: { auth: { value: "", reference: null } } } });
  expect(await control.handle("control", { key, nodeId: "node", state: "running" })).toEqual({ cancelled: false });
  expect(update).not.toHaveBeenCalled();
  await expect(control.handle("control", { key, nodeId: "node", state: "uploading" })).rejects.toThrow(/cannot upload/);
  control.cancel(key);
  expect(await control.handle("control", { key, nodeId: "node", state: "running" })).toEqual({ cancelled: true });
  await expect(control.handle("runtime", { key, nodeId: "node", hostname: "host", packageDigest: "digest", pluginVersions: versions }))
    .rejects.toThrow(/cancelled/);
});

test("batch execution requires a valid ready digest, frozen node, deadline and version", () => {
  expect(validateRemoteJob(job).preparation?.mode).toBe("prepare");
  expect(() => validateRemoteJob({ ...job, schemaVersion: 1 })).toThrow(/requires preparation/);
  expect(() => validateRemoteJob({ ...job, preparation: { ...job.preparation, mode: "execute" } })).toThrow(/receipt/);
  const ready = { ...job.preparation, mode: "execute", digest: "b".repeat(64) };
  expect(validateRemoteJob({ ...job, preparation: ready }).preparation?.digest).toBe(ready.digest);
  expect(() => validateRemoteJob({ ...job, preparation: { ...ready, mode: ["execute"] } })).toThrow();
  expect(() => validateRemoteJob({ ...job, preparation: { ...ready, roundId: "../round" } })).toThrow();
  expect(() => validateRemoteJob({ ...job, preparation: { ...ready, deadlineAt: "never" } })).toThrow();
});

test("preparation may omit the round deadline but must validate node concurrency and scaled timer bounds", () => {
  expect(validateRemoteJob({ ...job, preparation: { ...job.preparation, deadlineAt: null } }).preparation?.deadlineAt).toBeNull();
  for (const concurrency of [0, -1, 1.5, "4"])
    expect(() => validateRemoteJob({ ...job, preparation: { ...job.preparation, concurrency } })).toThrow();
  expect(() => validateRemoteJob({ ...job, preparation: { ...job.preparation, defaultTimeoutSeconds: 2147484 } })).toThrow();
});
