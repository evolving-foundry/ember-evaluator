import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { resolvePinnedTaskImage } from "../../src/infrastructure/containers/base-image.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "pinned sources disappear and Evaluator names remain usable with the registry offline",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-base-image-smoke-"));
    const name = `evaluator-base-source-${randomUUID()}`;
    const hash = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux",
      config: { Labels: { "evaluator.base-test": name } }, rootfs: { type: "layers", diff_ids: [] } }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: hash(config), size: config.length }, layers: [] }));
    const digest = hash(manifest);
    const calls: string[][] = [];
    const command: DockerCommand = async (args, options) => {
      calls.push([...args]);
      return runDockerCommand("docker", args, options);
    };
    // The opt-in test runs beside a local daemon (toolbox uses host networking).
    const registry = createServer((request, response) => {
      response.setHeader("Docker-Distribution-Api-Version", "registry/2.0");
      let data: Buffer;
      if (request.url === "/v2/") data = Buffer.from("{}");
      else if (request.url?.includes("/manifests/")) {
        data = manifest;
        response.setHeader("Content-Type", "application/vnd.docker.distribution.manifest.v2+json");
        response.setHeader("Docker-Content-Digest", digest);
      } else if (request.url?.endsWith(`/blobs/${hash(config)}`)) data = config;
      else { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Length", data.length);
      response.end(request.method === "HEAD" ? undefined : data);
    });
    const images = new Set<string>();
    vi.stubEnv("EVALUATOR_CACHE_DIR", root);
    try {
      await new Promise<void>(resolve => registry.listen(0, "0.0.0.0", resolve));
      const address = registry.address();
      if (!address || typeof address === "string") throw new Error("Registry did not bind a TCP port");
      const repository = `127.0.0.1:${address.port}/${name}`;
      const source = `${repository}@${digest}`;
      images.add(source);
      const scope = { taskId: `fixture/${name}`, phase: "solve" as const };
      const signal = AbortSignal.timeout(45_000);
      const first = await resolvePinnedTaskImage(command, source, "linux/amd64", scope, signal);
      if (!first) throw new Error("Missing pinned image");
      images.add(first.pinnedReference);
      expect(first).toMatchObject({ reference: source,
        pinnedReference: expect.stringMatching(/^ember-evaluator\/.+:solve-base-/u) });
      await expect(runDockerCommand("docker", ["image", "inspect", source], { signal })).rejects.toThrow();
      expect((await runDockerCommand("docker", ["image", "ls", "--format", "{{.Repository}}", repository], { signal })).stdout.trim()).toBe("");
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve()));
      expect(await resolvePinnedTaskImage(command, source, "linux/amd64", scope, signal)).toEqual(first);
      const other = await resolvePinnedTaskImage(command, source, "linux/amd64", { ...scope, phase: "verify" }, signal);
      if (!other) throw new Error("Missing verifier image");
      images.add(other.pinnedReference);
      expect(other.id).toBe(first.id);
      expect(other.pinnedReference).not.toBe(first.pinnedReference);
      expect(calls.filter(args => args[0] === "pull")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      registry.closeAllConnections();
      if (registry.listening) await new Promise<void>(resolve => registry.close(() => resolve()));
      for (const image of images) {
        try { await runDockerCommand("docker", ["image", "inspect", image], { signal: AbortSignal.timeout(5000) }); }
        catch { continue; }
        await runDockerCommand("docker", ["image", "rm", "--no-prune", image], { signal: AbortSignal.timeout(30_000) });
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 75_000,
);
