import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { startTransferReceiver } from "../../src/infrastructure/transfer/https.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { createGatewayCertificate } from "../fixtures/ray/gateway-certificate.js";

test.skipIf(spawnSync("openssl", ["version"], { windowsHide: true }).status !== 0)(
  "a preparation-only HTTPS service accepts authenticated control and exposes no upload routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ray-preparation-control-"));
    let server: Awaited<ReturnType<typeof startTransferReceiver>> | undefined;
    try {
      await createGatewayCertificate(root);
      const cert = await readFile(join(root, "cert.pem"));
      const token = "preparation-control-token-".repeat(2);
      const control = vi.fn(async () => ({ cancelled: false }));
      server = await startTransferReceiver({ token, key: await readFile(join(root, "key.pem")), cert, control });
      const client = new JobsClient(server.url, cert, token);
      expect(await client.call("/v1/control", {})).toEqual({ cancelled: false });
      await expect(client.call("/v1/begin", {})).rejects.toMatchObject({ statusCode: 404 });
      await expect(client.call("/v1/commit/any", {})).rejects.toMatchObject({ statusCode: 404 });
      const denied = new JobsClient(server.url, cert, "invalid");
      await expect(denied.call("/v1/control", {})).rejects.toMatchObject({ statusCode: 401 });
      expect(control).toHaveBeenCalledTimes(1);
    } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
  }, 10_000,
);
