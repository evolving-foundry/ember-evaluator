import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { taskArchiveUrl, downloadArchiveImage } from "../../src/infrastructure/containers/archive-image.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { DockerTaskArchive } from "../../src/infrastructure/containers/task-archive.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import type { ArchiveImageAcquisition } from "../../src/core/contracts/network.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(status = 200) {
  const root = await mkdtemp(join(tmpdir(), "task-archive-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("EVALUATOR_CACHE_DIR", root);
  const requests: string[] = [];
  const bytes = Buffer.from("opaque docker-save bytes; the downloader must not inspect these");
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status); response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const settings: ArchiveImageAcquisition = { method: "archive", provider: "modelscope", baseUrl: `http://127.0.0.1:${address.port}/terminalbench4.0` };
  const network = new NetworkRuntime(networkDocument({}, {})); cleanup.push(() => network.dispose());
  return { root, requests, bytes, settings, network };
}
const context = { taskId: "terminal-bench/task-a", phase: "solve" as const };

test("fixed URLs select task, platform, phase and service without a catalog", () => {
  const settings: ArchiveImageAcquisition = { method: "archive", provider: "huggingface", baseUrl: "https://huggingface.co/datasets/team/images/resolve/v1/terminalbench4.0/" };
  expect(taskArchiveUrl(settings, context, "linux/amd64")).toBe(settings.baseUrl + "task-a/linux/amd64/solve.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, phase: "verify" }, "linux/arm64")).toBe(settings.baseUrl + "task-a/linux/arm64/verify.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, service: "api one" }, "linux/arm64")).toBe(settings.baseUrl + "task-a/linux/arm64/solve/services/api%20one.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, taskId: "task-a" }, "linux/amd64")).toBe(settings.baseUrl + "task-a/linux/amd64/solve.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, taskId: "benchmark/group/task a" }, "linux/amd64")).toBe(settings.baseUrl + "group/task%20a/linux/amd64/solve.tar.gz");
  for (const taskId of ["../escape", "task/../escape", "/task", "task//empty"])
    expect(() => taskArchiveUrl(settings, { ...context, taskId }, "linux/amd64")).toThrow("path segment");
});

test("only the requested archive is downloaded, with no checksum or format requirement", async () => {
  const f = await fixture();
  const url = taskArchiveUrl(f.settings, context, "linux/arm64");
  const path = await downloadArchiveImage(url, f.settings, f.network, f.root, AbortSignal.timeout(5000));
  expect(await readFile(path)).toEqual(f.bytes);
  expect(f.requests).toEqual(["/terminalbench4.0/task-a/linux/arm64/solve.tar.gz"]);
});

test.each(["Loaded image ID: sha256:" + "a".repeat(64), "Loaded image: publisher/task:arm64"])(
  "loads Docker output %s directly and shares the image cache", async loaded => {
    const f = await fixture(); const images = new Map<string, string>(); const calls: string[][] = [];
    const id = "sha256:" + "b".repeat(64);
    const command: DockerCommand = async args => {
      calls.push(args);
      if (args[0] === "load") { expect(await readFile(args[2]!)).toEqual(f.bytes); return { stdout: loaded + "\n", stderr: "" }; }
      if (args[1] === "tag") { images.set(args[3]!, id); return { stdout: "", stderr: "" }; }
      if (args[1] === "inspect") { const value = images.get(args[2]!); if (!value) throw new Error("No such image"); return { stdout: value, stderr: "" }; }
      throw new Error("Unexpected Docker operation");
    };
    const loader = new DockerTaskArchive(command, f.settings, f.network);
    const [first, second] = await Promise.all([
      loader.load(context, "linux/arm64", AbortSignal.timeout(5000)),
      loader.load(context, "linux/arm64", AbortSignal.timeout(5000)),
    ]);
    expect(first).toEqual(second); expect(first.id).toBe(id);
    expect(f.requests).toHaveLength(1); expect(calls.filter(args => args[0] === "load")).toHaveLength(1);
    expect(calls.every(args => !args.includes("--platform") && !args.some(arg => /Architecture|RepoDigests/u.test(arg)))).toBe(true);
    const cached = await new DockerTaskArchive(command, f.settings, f.network).load(context, "linux/arm64", AbortSignal.timeout(5000));
    expect(cached).toEqual(first); expect(f.requests).toHaveLength(1);
  });

test("HTTP 404 does not fall back to another platform or registry", async () => {
  const f = await fixture(404);
  const command: DockerCommand = async () => { throw new Error("No such image"); };
  await expect(new DockerTaskArchive(command, f.settings, f.network).load(context, "linux/arm64", AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: "ENV_IMAGE_PULL_FAILED", cause: { message: expect.stringContaining("404") } });
  expect(f.requests).toEqual(["/terminalbench4.0/task-a/linux/arm64/solve.tar.gz"]);
});

test("Docker load failure creates no usable tag and a retry downloads again", async () => {
  const f = await fixture(); let loads = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "load") { loads++; throw new Error("invalid tar header"); }
    if (args[1] === "inspect") throw new Error("No such image");
    throw new Error("Unexpected tag after failed load");
  };
  const loader = new DockerTaskArchive(command, f.settings, f.network);
  for (let i = 0; i < 2; i++) await expect(loader.load(context, "linux/amd64", AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ cause: { message: "invalid tar header" } });
  expect(loads).toBe(2); expect(f.requests).toHaveLength(2);
});

test("a cancelled acquisition does not download or run Docker", async () => {
  const f = await fixture(); const command = vi.fn<DockerCommand>();
  await expect(new DockerTaskArchive(command, f.settings, f.network).load(context, "linux/amd64", AbortSignal.abort()))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(f.requests).toEqual([]); expect(command).not.toHaveBeenCalled();
});
