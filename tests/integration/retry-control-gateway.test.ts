import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { controlTransaction, RetryControl } from "../../src/application/retry-control/mailbox.js";
import { createGatewayCertificate } from "../fixtures/ray/gateway-certificate.js";

const available = spawnSync("openssl", ["version"], { windowsHide: true }).status === 0 && existsSync("dist/application/retry-control/mailbox.js");
test.skipIf(!available)("Jobs gateway delivers IPC requests to the active original or recovery coordinator without creating another Job", async () => {
  const root = await mkdtemp(join(tmpdir(), "retry-gateway-"));
  const jobs = join(root, "jobs"), security = join(root, "security");
  const jobId = randomUUID(), runId = randomUUID(), recoveryId = randomUUID();
  const runRoot = join(jobs, jobId, "results", runId);
  const token = randomUUID() + randomUUID();
  let child: ChildProcess | undefined;
  let control: RetryControl | undefined;
  const states = new Map<string, string>([[jobId, "RUNNING"], [recoveryId, "RUNNING"]]);
  let submissions = 0;
  const backend = createServer((req, res) => {
    if (req.method === "POST") submissions++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: states.get(req.url?.split("/").at(-1) ?? "") ?? "RUNNING" }));
  });
  try {
    await mkdir(security); await mkdir(runRoot, { recursive: true });
    await writeFile(join(security, "jobs-token"), token);
    await createGatewayCertificate(security);
    await writeFile(join(runRoot, "manifest.json"), JSON.stringify({ runId, pluginVersions: {} }));
    control = await RetryControl.start(runRoot, vi.fn());
    const admitted: string[] = [];
    await control.setAdmission(async requests => {
      for (const request of requests) { request.status = "accepted"; request.bindings.a = "failed"; }
      return { commit() { admitted.push(...requests.map(request => request.requestId)); }, release() {} };
    });
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address(); if (!address || typeof address === "string") throw new Error("No backend port");
    child = spawn(process.execPath, [resolve("src/application/ray/entries/jobs-gateway.mjs")], { windowsHide: true,
      env: { ...process.env, EVALUATOR_JOBS_ROOT: jobs, EVALUATOR_JOBS_SECURITY: security, EVALUATOR_JOBS_PORT: "0", EVALUATOR_RAY_DASHBOARD: `http://127.0.0.1:${address.port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Gateway did not start")), 10_000);
      let output = "";
      child?.once("error", error => { clearTimeout(timeout); reject(error); });
      child?.once("exit", () => { clearTimeout(timeout); reject(new Error(`Gateway exited: ${output}`)); });
      child?.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child?.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = /HTTPS :(\d+)/u.exec(output);
        if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
      });
    });
    const client = new JobsClient(`https://127.0.0.1:${port}`, await readFile(join(security, "cert.pem")), token);
    const request = (requestId: string) => client.call(`/jobs/${jobId}/retry`, {
      runId, requestId, taskIds: ["a"], reason: "network restored", pluginVersions: {}, serviceAuth: { default: "fixture-key" },
    });
    expect(await request("original")).toMatchObject({ requestId: "original", status: "accepted" });
    expect(await request("original")).toMatchObject({ requestId: "original", status: "accepted" });
    states.set(jobId, "SUCCEEDED");
    await controlTransaction(runRoot, async state => { state.recoveryJobId = recoveryId; });
    expect(await request("recovery")).toMatchObject({ requestId: "recovery", status: "accepted" });
    expect(admitted).toEqual(["original", "recovery"]);
    expect(submissions).toBe(0);
    await controlTransaction(runRoot, async state => { expect(state.accepting).toBe(true); });
    await control.close();
    await expect(request("unavailable")).rejects.toMatchObject({ statusCode: 409 });
    await controlTransaction(runRoot, async state => { expect(state.requests.map(item => item.requestId)).toEqual(["original", "recovery"]); });
    expect(submissions).toBe(0);
  } finally {
    if (child && child.exitCode === null) {
      const stopped = new Promise<void>(resolve => child?.once("exit", () => resolve())); child.kill(); await stopped;
    }
    await control?.close();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
