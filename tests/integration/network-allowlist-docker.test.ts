import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

const enabled = process.env.EVALUATOR_HARBOR_DOCKER_TESTS === "1";
const signal = () => AbortSignal.timeout(180_000);
test.skipIf(!enabled)("Docker enforces task allowlists, preserves the model route and removes egress before verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "allowlist-docker-"));
  const upstream = createServer((_req, res) => res.end("fixture"));
  await new Promise<void>(resolve => upstream.listen(0, "0.0.0.0", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("No upstream port");
  const origin = `http://host.docker.internal:${address.port}`;
  const environment = new DockerEnvironment({ modelEndpoint: origin + "/v1" });
  let session: EnvironmentSession | undefined;
  let volume: string | undefined;
  const execute = async (script: string, env: Record<string, string> = {}) => {
    const result = await readProcess(await session!.start({ executable: "node", args: ["-e", script], cwd: "/app", env, input: null }, signal()), signal());
    if (result.code !== 0) throw new Error(result.stderr);
    return result;
  };
  try {
    session = await environment.prepare({ image: PINNED_NODE_IMAGE, workdir: "/app", runtime: [], initialFiles: [],
      network: { kind: "allowlist", allowedHosts: ["host.docker.internal", "pypi.org"] } },
    { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") }, "solve", signal());
    expect((await execute(`fetch(${JSON.stringify(origin + "/allowed")}).then(async r=>console.log(r.status,await r.text()))`)).stdout).toContain("200 fixture");
    const model = session.modelEndpoint?.baseUrl;
    const metadata = session.metadata;
    const endpoint = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.modelEndpoint : null;
    const gateway = endpoint && typeof endpoint === "object" && !Array.isArray(endpoint) ? endpoint.gateway : null;
    volume = gateway && typeof gateway === "object" && !Array.isArray(gateway) && typeof gateway.volume === "string" ? gateway.volume : undefined;
    expect(volume).toBeTruthy();
    expect(model).toBeTruthy();
    expect((await execute(`fetch(${JSON.stringify(model + "/chat/completions")}).then(async r=>console.log(r.status,await r.text()))`)).stdout).toContain("200 fixture");
    expect((await execute('fetch("http://blocked.invalid/").then(r=>console.log(r.status === 403 ? "denied" : "unexpected")).catch(()=>console.log("denied"))')).stdout).toContain("denied");
    expect((await execute('fetch("https://blocked.invalid/").then(()=>process.exit(2)).catch(()=>console.log("denied"))')).stdout).toContain("denied");
    expect((await execute('fetch("https://pypi.org/simple/pip/").then(r=>{console.log(r.status);r.body.cancel()})')).stdout).toContain("200");
    // A program that ignores proxy variables cannot obtain a direct TCP route.
    expect((await execute('const s=require("node:net").connect(443,"1.1.1.1");s.on("connect",()=>process.exit(2));s.on("error",()=>console.log("isolated"));s.setTimeout(2000,()=>{console.log("isolated");s.destroy()})',
      { HTTP_PROXY: "", HTTPS_PROXY: "", NODE_USE_ENV_PROXY: "0" })).stdout).toContain("isolated");
    await session.transitionToVerification!({ kind: "allowlist", allowedHosts: [] }, signal());
    expect((await execute(`fetch(${JSON.stringify(origin + "/allowed")}).then(r=>console.log(r.status === 403 ? "denied" : "unexpected")).catch(()=>console.log("denied"))`)).stdout).toContain("denied");
    await session.transitionToVerification!("bridge", signal());
    expect((await execute(`fetch(${JSON.stringify(origin + "/public")}).then(async r=>console.log(r.status,await r.text()))`)).stdout).toContain("200 fixture");
    await session.transitionToVerification!("none", signal());
    expect((await execute('fetch("https://pypi.org",{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(2)).catch(()=>console.log("offline"))')).stdout).toContain("offline");
  } finally {
    await session?.dispose(signal());
    await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
  await expect(runDockerCommand("docker", ["volume", "inspect", volume!], { signal: signal() })).rejects.toThrow(/no such volume/iu);
}, 300_000);
