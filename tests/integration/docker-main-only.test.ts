import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import type { EnvironmentSpec, EnvironmentSession } from "../../src/core/contracts/environment.js";

const enabled = process.env.EVALUATOR_COMPOSE_DOCKER_TESTS === "1";
const signal = () => AbortSignal.timeout(180_000);
const policies = ["none", "model-api", "allowlist"] as const;

test.skipIf(!enabled).each(policies)("main-only Compose preserves /opt and task startup under %s", async policy => {
  const root = await mkdtemp(join(tmpdir(), "main-only-docker-"));
  let upstream: string | undefined;
  let session: EnvironmentSession | undefined;
  const docker = (args: string[]) => runDockerCommand("docker", args, { signal: signal() });
  try {
    // A local fixture container stands in for both an allowed download host
    // and the model API. No benchmark data, credentials or internet requests.
    upstream = (await docker(["run", "--detach", "--publish", "0:8080", PINNED_NODE_IMAGE,
      "node", "-e", "require('node:http').createServer((q,r)=>r.end('synthetic-upstream')).listen(8080,'0.0.0.0')"])).stdout.trim();
    const port = /:(\d+)/u.exec((await docker(["port", upstream, "8080/tcp"])).stdout)?.[1];
    if (!port) throw new Error("Missing synthetic upstream port");
    const origin = `http://host.docker.internal:${port}`;
    const environment = new DockerEnvironment({ modelEndpoint: origin + "/v1" });
    const source = join(root, "input.txt");
    await writeFile(source, "synthetic-input");
    const network: EnvironmentSpec["network"] = policy === "allowlist"
      ? { kind: "allowlist", allowedHosts: ["host.docker.internal"] } : policy;
    const startup = "const f=require('node:fs');f.mkdirSync('/opt/synthetic',{recursive:true});f.appendFileSync('/opt/synthetic/startups','once\\n');require('node:http').createServer((q,r)=>r.end('synthetic-service')).listen(8811,'127.0.0.1');";
    const spec: EnvironmentSpec = { image: PINNED_NODE_IMAGE, workdir: "/opt", runtime: [], network,
      executionUsers: { solve: "dev", verify: "root" },
      initialFiles: [{ source, target: "synthetic/input.txt" }],
      services: { main: { image: null, properties: { command: policy === "model-api" ? `node -e ${JSON.stringify(startup)}` : ["node", "-e", startup],
        healthcheck: { test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8811').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
          interval: "1s", timeout: "3s", retries: 20 } } } } };
    const attempt = join(root, "attempt");
    session = await environment.prepare(spec, { root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts") }, "solve", signal());
    const execute = async (code: string) => {
      if (!session) throw new Error("Missing synthetic session");
      const result = await readProcess(await session.start({ executable: "node", args: ["-e", code], cwd: session.workdir, env: {}, input: null }, signal()), signal());
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    expect(session.workdir).toBe("/opt");
    expect(await execute("console.log(process.getuid()===0)")).toBe("false\n");
    expect(await execute("console.log(process.cwd(),require('node:fs').readFileSync('synthetic/input.txt','utf8'))")).toBe("/opt synthetic-input\n");
    expect(await execute("require('node:http').get('http://127.0.0.1:8811',r=>r.pipe(process.stdout))")).toBe("synthetic-service");
    // Transfers may use task subdirectories, never the encompassing /opt or
    // the runtime helpers installed beneath it.
    for (const path of ["/opt", "/opt/evaluator", "/opt/evaluator-agent"]) {
      await expect(session.upload(source, path, signal())).rejects.toMatchObject({ code: "TRANSFER_UNSAFE" });
      await expect(session.download(path, join(root, "forbidden"), signal())).rejects.toMatchObject({ code: "TRANSFER_UNSAFE" });
    }
    await session.download("synthetic/input.txt", join(root, "downloaded"), signal());
    expect(await readFile(join(root, "downloaded"), "utf8")).toBe("synthetic-input");
    await expect(session.exportState({ kind: "workspace-archive", workdir: "/opt", extraPaths: [] }, join(root, "forbidden.tar"), signal()))
      .rejects.toMatchObject({ code: "TRANSFER_UNSAFE" });
    const direct = `const s=require('node:net').connect(${port},'host.docker.internal');s.on('connect',()=>process.exit(2));s.on('error',()=>console.log('isolated'));s.setTimeout(1000,()=>{s.destroy();console.log('isolated')});`;
    expect(await execute(direct)).toContain("isolated");
    if (policy !== "none") {
      const model = session.modelEndpoint?.baseUrl;
      expect(model).toBeTruthy();
      expect(await execute(`fetch(${JSON.stringify(model + "/chat/completions")}).then(async r=>{if(!r.ok)throw Error(String(r.status));console.log(await r.text())})`)).toBe("synthetic-upstream\n");
      if (policy === "allowlist") {
        expect((await execute(`fetch(${JSON.stringify(origin + "/download")}).then(async r=>console.log(r.status,await r.text()))`)).trim()).toBe("200 synthetic-upstream");
        expect(await execute("fetch('http://blocked.invalid/').then(r=>console.log(r.status===403?'denied':'unexpected')).catch(()=>console.log('denied'))")).toBe("denied\n");
      } else {
        const forbidden = new URL("/outside-model", model).href;
        expect(await execute(`fetch(${JSON.stringify(forbidden)}).then(r=>console.log(r.status))`)).toBe("403\n");
      }
    }
    await session.transitionToVerification?.("none", signal());
    expect(await execute("console.log(process.getuid()===0)")).toBe("true\n");
    expect(await execute("console.log(require('node:fs').readFileSync('/opt/synthetic/startups','utf8'))")).toBe("once\n\n");
    expect(await execute(direct)).toContain("isolated");
    if (policy !== "none") expect(await execute(`fetch(${JSON.stringify(session.modelEndpoint?.baseUrl + "/chat/completions")},{signal:AbortSignal.timeout(1500)}).then(()=>process.exit(2)).catch(()=>console.log('offline'))`)).toBe("offline\n");
  } finally {
    try { await session?.dispose(signal()); }
    finally {
      if (upstream) await docker(["rm", "--force", upstream]);
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);
