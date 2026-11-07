import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { parseJobsConfig } from "../../src/config/jobs.js";

const roots: string[] = [];
const fileToken = "f".repeat(64);
const envToken = "e".repeat(64);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(tokenEnv = "EVALUATOR_JOBS_TOKEN") {
  const root = await mkdtemp(join(tmpdir(), "jobs-credentials-"));
  roots.push(root);
  await writeFile(join(root, "cert.pem"), "fixture certificate");
  vi.stubEnv(tokenEnv, undefined);
  const config = parseJobsConfig({ transport: "jobs", endpoint: "https://example.test", caFile: "cert.pem", tokenEnv });
  return { root, create: (modelApiKeys: string[] = []) => JobsClient.create(config, path => join(root, path), modelApiKeys) };
}

test("loads the gateway token beside the resolved CA and trims file whitespace", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "jobs-token"), ` ${fileToken}\r\n`);
  await expect(f.create()).resolves.toBeInstanceOf(JobsClient);
  await expect(f.create([fileToken])).rejects.toThrow("must differ from the model API key");
  vi.stubEnv("EVALUATOR_JOBS_TOKEN", "");
  await expect(f.create()).resolves.toBeInstanceOf(JobsClient);
});

test("custom environment variable takes precedence and needs no token file", async () => {
  const f = await fixture("TEST_JOBS_CREDENTIAL");
  vi.stubEnv("TEST_JOBS_CREDENTIAL", envToken);
  await expect(f.create()).resolves.toBeInstanceOf(JobsClient);
  await writeFile(join(f.root, "jobs-token"), fileToken);
  await expect(f.create([fileToken])).resolves.toBeInstanceOf(JobsClient);
  await expect(f.create(["another-model-key", envToken])).rejects.toThrow("must differ from the model API key");
});

test("invalid explicit token does not silently fall back to a valid file", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "jobs-token"), fileToken);
  vi.stubEnv("EVALUATOR_JOBS_TOKEN", "short-secret");
  await expect(f.create()).rejects.toThrow("EVALUATOR_JOBS_TOKEN must be at least 32 characters");
});

test("missing and short credential files produce actionable errors without secrets", async () => {
  const f = await fixture();
  await expect(f.create()).rejects.toThrow(`Set EVALUATOR_JOBS_TOKEN or provide the gateway credential in ${join(f.root, "jobs-token")}`);
  await writeFile(join(f.root, "jobs-token"), "short-secret\n");
  await expect(f.create()).rejects.toThrow(`Jobs gateway credential from ${join(f.root, "jobs-token")} must be at least 32 characters`);
});

test("explicit managedLocal override is limited to the loopback gateway", () => {
  const local = parseJobsConfig({
    transport: "jobs", endpoint: "https://localhost:9443", caFile: "cert.pem", managedLocal: true,
  });
  expect(local.managedLocal).toBe(true);
  expect(parseJobsConfig({ transport: "jobs", endpoint: "https://localhost:9443", caFile: "cert.pem" }).managedLocal)
    .toBeUndefined();
  expect(() => parseJobsConfig({
    transport: "jobs", endpoint: "https://example.test", caFile: "cert.pem", managedLocal: true,
  })).toThrow("managedLocal requires https://localhost:9443");
  expect(() => parseJobsConfig({
    transport: "jobs", endpoint: "https://localhost:9443", caFile: "cert.pem", managedLocal: "true",
  })).toThrow("managedLocal must be a boolean");
});

test("local Jobs connection defaults to the managed gateway and certificate", () => {
  expect(parseJobsConfig({ concurrency: 2 })).toMatchObject({
    transport: "jobs",
    endpoint: "https://localhost:9443",
    caFile: resolve(".scratch/ray-smoke/security/cert.pem"),
    tokenEnv: "EVALUATOR_JOBS_TOKEN",
    concurrency: 2,
  });
  expect(() => parseJobsConfig({ transport: "jobs", endpoint: "https://example.test" })).toThrow("Jobs caFile");
});
