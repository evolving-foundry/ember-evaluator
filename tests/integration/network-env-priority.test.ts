import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { loadNetworkConfig } from "../../src/config/network.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";

test("downloads use the environment proxy instead of YAML routes and noProxy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-env-proxy-"));
  const requests: string[] = [];
  const proxy = createServer((request, response) => { requests.push(request.url ?? ""); response.end("downloaded"); });
  let runtime: NetworkRuntime | undefined;
  try {
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    const path = join(directory, "network.yaml");
    await writeFile(path, "proxy:\n  http: http://127.0.0.1:1\n  noProxy: [source.invalid]\n  overrides:\n    host: null\n");
    const document = await loadNetworkConfig(path, { HTTP_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "localhost" });
    runtime = new NetworkRuntime(document);
    const response = await runtime.fetch("http://source.invalid/fixture", { signal: AbortSignal.timeout(5000) });
    expect(await response.text()).toBe("downloaded");
    expect(requests).toEqual(["http://source.invalid/fixture"]);
    const installer = runtime.environment("build", { HTTP_PROXY: "http://stale.test", HF_ENDPOINT: "https://stale.test" });
    expect(installer.HTTP_PROXY).toBe(`http://127.0.0.1:${address.port}`);
    expect(installer.http_proxy).toBe(installer.HTTP_PROXY);
  } finally {
    await runtime?.dispose();
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("the dependency-free bootstrap forwards environment overrides to its child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-env-bootstrap-"));
  try {
    const path = join(directory, "network.yaml");
    await writeFile(path, "proxy:\n  https: http://yaml.test\nsources:\n  huggingface: https://yaml.test\n  python:\n    index: https://yaml.test/simple\n");
    const { stdout } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../scripts/network/bootstrap.mjs", import.meta.url)), "--network", path, "--", process.execPath,
      "--eval", "console.log(JSON.stringify({proxy:process.env.HTTPS_PROXY,hub:process.env.HF_ENDPOINT,index:process.env.PIP_INDEX_URL}))",
    ], { env: { ...process.env, HTTPS_PROXY: "http://env.test", HF_ENDPOINT: "https://env.test", UV_DEFAULT_INDEX: "https://env.test/simple" }, timeout: 10000, windowsHide: true });
    expect(JSON.parse(stdout)).toEqual({ proxy: "http://env.test", hub: "https://env.test", index: "https://env.test/simple" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
