import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import type { EnvironmentSpec, EnvironmentSession } from "../../src/core/contracts/environment.js";
const enabled = process.env.EVALUATOR_COMPOSE_DOCKER_TESTS === "1";
const image = process.env.EVALUATOR_COMPOSE_TEST_IMAGE ?? "node:24.22.1-bookworm-slim";
const dockerExecutable = process.env.EVALUATOR_TEST_DOCKER_EXECUTABLE ?? "docker";
const signal = () => AbortSignal.timeout(180_000);
async function execute(session: EnvironmentSession, code: string) {
  return readProcess(await session.start({ executable: "node", args: ["-e", code], cwd: "/app", env: {}, input: null }, signal()), signal());
}
test.skipIf(!enabled)("Docker task groups isolate services and restore sidecar artifacts into verifier main", async () => {
  const root = await mkdtemp(join(process.env.EVALUATOR_COMPOSE_TEST_TMP ?? tmpdir(), "compose-integration-"));
  const environment = new DockerEnvironment({ dockerExecutable });
  const sessions: EnvironmentSession[] = [];
  const spec: EnvironmentSpec = { image, workdir: "/app", runtime: [], initialFiles: [], network: "bridge",
    resources: { cpus: 2 }, env: { NODE_OPTIONS: "--no-warnings" },
    services: { api: { image, properties: {
      command: ["node", "-e", "require('http').createServer((q,r)=>r.end('isolated')).listen(8080)"],
      healthcheck: { test: ["CMD", "node", "-e", "fetch('http://localhost:8080').then(r=>process.exit(r.ok?0:1))"], interval: "1s", timeout: "3s", retries: 20 },
    } }, seeder: { image, properties: { command: ["node", "-e", "process.exit(0)"] } },
    main: { image: null, properties: { network_mode: "service:api", depends_on: { api: { condition: "service_healthy" }, seeder: { condition: "service_completed_successfully" } } } } } };
  try {
    const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
    const solve = await environment.prepare(spec, paths, "solve", signal()); sessions.push(solve);
    const cpu = await execute(solve, "const os=require('node:os');console.log(JSON.stringify({available:os.availableParallelism(),cpus:os.cpus().length,options:process.env.NODE_OPTIONS}))");
    expect(cpu.code).toBe(0);
    expect(JSON.parse(cpu.stdout)).toEqual({ available: 2, cpus: 2, options: "--require=/opt/evaluator/cpu-view.cjs --no-warnings" });
    expect((await execute(solve, "require('node:dns').lookup('host.docker.internal',(error,address)=>{if(error)throw error;console.log(require('node:net').isIP(address)>0)})")).stdout.trim()).toBe("true");
    expect((await execute(solve, "fetch('http://localhost:8080').then(async r=>console.log(await r.text()))")).stdout.trim()).toBe("isolated");
    await solve.transitionToVerification?.(undefined, signal());
    if (!solve.startService) throw new Error("Missing service operations");
    const hook = await solve.startService("api", { executable: "node", args: ["-e", "require('fs').mkdirSync('/shared',{recursive:true});require('fs').writeFileSync('/shared/result.txt','collected')"], cwd: "/app", env: {}, input: null }, signal());
    expect((await readProcess(hook, signal())).code).toBe(0);
    await solve.quiesce?.(signal());
    const artifact = await solve.exportState({ kind: "artifacts", workdir: "/app", paths: ["/shared/result.txt"], services: { "/shared/result.txt": "api" } }, join(paths.artifacts, "result.tar"), signal());
    const verify = await environment.prepare({ image, workdir: "/app", runtime: [], initialFiles: [], network: "none" }, paths, "verify", signal()); sessions.push(verify);
    await verify.restoreState(artifact, signal());
    expect((await execute(verify, "console.log(require('fs').readFileSync('/shared/result.txt','utf8'))")).stdout.trim()).toBe("collected");
    expect(JSON.stringify(solve.metadata)).toContain("api");
  } finally {
    const outcomes = await Promise.allSettled(sessions.map(session => session.dispose(signal())));
    await rm(root, { recursive: true, force: true });
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}, 240_000);

test.skipIf(!enabled)("self-deleting task entrypoints are not replayed during quiesce, export or cleanup", async () => {
  const root = await mkdtemp(join(process.env.EVALUATOR_COMPOSE_TEST_TMP ?? tmpdir(), "compose-startup-"));
  const tag = `evaluator-compose-startup:${process.pid}`;
  const sessions: EnvironmentSession[] = [];
  const environment = new DockerEnvironment({ dockerExecutable });
  try {
    await writeFile(join(root, "entrypoint.sh"), '#!/bin/sh\nset -eu\necho first >> /app/startups\nrm /app/entrypoint.sh\nexec "$@"\n');
    await writeFile(join(root, "Dockerfile"), `FROM ${image}\nWORKDIR /app\nCOPY --chmod=755 entrypoint.sh /app/entrypoint.sh\nENTRYPOINT ["/app/entrypoint.sh"]\n`);
    await runDockerCommand(dockerExecutable, ["build", "--tag", tag, root], { signal: signal() });
    const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
    const solve = await environment.prepare({ image: tag, workdir: "/app", runtime: [], initialFiles: [], network: "bridge",
      services: { main: { image: null, properties: {} }, evidence: { image, properties: {
        command: ["node", "-e", "require('fs').mkdirSync('/results');require('fs').writeFileSync('/results/score','official-evidence');setInterval(()=>{},3600000)"],
      } } } }, paths, "solve", signal());
    sessions.push(solve);
    expect((await execute(solve, "console.log(require('fs').readFileSync('/app/startups','utf8'))")).stdout.trim()).toBe("first");
    expect((await execute(solve, "try{require('fs').writeFileSync('/opt/evaluator/session-bootstrap/maintenance','')}catch(e){console.log(e.code)}")).stdout.trim()).toBe("EROFS");
    await solve.quiesce?.(signal());
    await solve.quiesce?.(signal());
    await runDockerCommand(dockerExecutable, ["stop", "--time", "0", solve.id], { signal: signal() });
    const artifact = await solve.exportState({ kind: "artifacts", workdir: "/app", paths: ["/results/score", "/app/startups"],
      services: { "/results/score": "evidence" } }, join(paths.artifacts, "result.tar"), signal());
    const verify = await environment.prepare({ image, workdir: "/app", runtime: [], initialFiles: [], network: "none" }, paths, "verify", signal());
    sessions.push(verify);
    await verify.restoreState(artifact, signal());
    expect((await execute(verify, "console.log(require('fs').readFileSync('/results/score','utf8'))")).stdout.trim()).toBe("official-evidence");
    expect((await execute(verify, "console.log(require('fs').readFileSync('/app/startups','utf8'))")).stdout.trim()).toBe("first");
  } finally {
    try {
      const outcomes = await Promise.allSettled(sessions.map(session => session.dispose(signal())));
      const failed = outcomes.find(outcome => outcome.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      await runDockerCommand(dockerExecutable, ["image", "rm", tag]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
}, 240_000);
