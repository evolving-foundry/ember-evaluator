import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import { inspectWorkspaceArchive } from "../../src/infrastructure/filesystem/workspace-transfer.js";

const exec = promisify(execFile);
test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1" || process.platform !== "linux")("non-root task identity, private runtime assets and child-UID logs survive restrictive umask", async () => {
  const signal = AbortSignal.timeout(180000);
  const context = await mkdtemp(join(tmpdir(), "runtime-user-"));
  const image = `evaluator-runtime-user:${process.pid}`;
  const command = (args: string[], options?: { signal?: AbortSignal; maxBuffer?: number }) => runDockerCommand("docker", args, options);
  const node = new DockerRuntime(command);
  const environment = new DockerEnvironment();
  let session;
  const previous = process.umask(0o077);
  const previousPip = process.env.PIP_INDEX_URL;
  process.env.PIP_INDEX_URL = "https://packages.example.test/simple";
  try {
    await node.nodeImageDigest(signal);
    await writeFile(join(context, "Dockerfile"), `FROM ${node.nodeImage}\nRUN mkdir /workspace && chown nobody:nogroup /workspace\nENV EXPECT_TASK_USER=1\nUSER nobody\n`);
    await exec("docker", ["build", "--tag", image, context], { signal });
    const asset = join(context, "package.json");
    await writeFile(asset, "{}", { mode: 0o600 });
    const attempt = join(context, "attempt");
    const paths = { root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts") };
    session = await environment.prepare({ image, workdir: "/workspace", initialFiles: [], runtime: [], network: "none", installation: {
      id: "private-nonroot", files: [{ source: asset, target: "package.json" }], commands: [],
      probes: [{ executable: "node", args: ["-e", "if(process.env.EXPECT_TASK_USER&&process.getuid()===0)throw Error('privileged probe');require('fs').readFileSync('package.json')"] }],
    } }, paths, "solve", signal);
    const run = async (source: string) => readProcess(await session!.start({ executable: "node", args: ["-e", source], cwd: "/workspace", env: {}, input: null }, signal), signal);
    const proof = await run("if(process.getuid()!==65534)throw Error('USER changed');if(process.env.PIP_INDEX_URL!=='https://packages.example.test/simple')throw Error('pip mirror missing');const fs=require('fs');fs.writeFileSync('/logs/agent/child.log','ok',{mode:0o600});fs.mkdirSync('/workspace/readonly/nested',{recursive:true});fs.writeFileSync('/workspace/readonly/nested/export.txt','artifact',{mode:0o444});fs.chmodSync('/workspace/readonly/nested',0o555);fs.chmodSync('/workspace/readonly',0o555);fs.writeFileSync('/opt/evaluator-agent/state/proof','ok');console.log('nonroot-ok')");
    expect(proof).toMatchObject({ code: 0, stdout: "nonroot-ok\n" });
    expect((await stat(attempt)).mode & 0o777).toBe(0o700);
    await session.quiesce!(signal);
    expect((await stat(paths.agent)).mode & 0o777).toBe(0o700);
    await session.transitionToVerification!(undefined, signal);
    const verified = await run("require('fs').writeFileSync('/logs/verifier/reward.txt','0')");
    expect(verified.code).toBe(0);
    const guarded = await run("const fs=require('fs'),cp=require('child_process');const token='abcdefab-1234-1234-1234-abcdefabcdef';const stage='/opt/evaluator/transfers/'+token;fs.mkdirSync('/workspace/guard');fs.writeFileSync('/workspace/guard/proof','untouched',{mode:0o600});fs.chmodSync('/workspace/guard',0o555);fs.mkdirSync(stage+'/nested',{recursive:true});fs.symlinkSync('/workspace/guard',stage+'/nested/outside');fs.chmodSync(stage+'/nested',0o555);cp.execFileSync(process.execPath,['/opt/evaluator/workspace-transfer.mjs','cleanup',token]);if(fs.existsSync(stage)||(fs.statSync('/workspace/guard').mode&0o777)!==0o555||fs.readFileSync('/workspace/guard/proof','utf8')!=='untouched')throw Error('cleanup escaped staging')");
    expect(guarded.code).toBe(0);
    const artifact = await session.exportState!({ kind: "artifacts", workdir: "/workspace", paths: ["/workspace/readonly"] }, join(context, "state.tar"), signal);
    expect((await stat(artifact.path)).size > 0).toBe(true);
    const manifest = await inspectWorkspaceArchive(artifact, "/workspace", signal);
    expect(manifest.entries.find(entry => entry.path === "payload/0")?.mode).toBe(0o555);
    expect(manifest.entries.find(entry => entry.path === "payload/0/nested/export.txt")?.mode).toBe(0o444);
    await session.dispose(signal); session = undefined;
    expect((await stat(paths.verifier)).mode & 0o777).toBe(0o700);
    expect((await stat(join(paths.agent, "child.log"))).uid).toBe(process.getuid?.());
  } finally {
    process.umask(previous);
    if (previousPip === undefined) delete process.env.PIP_INDEX_URL;
    else process.env.PIP_INDEX_URL = previousPip;
    await session?.dispose(AbortSignal.timeout(30000));
    await exec("docker", ["image", "rm", image]).catch(() => undefined);
    await rm(context, { recursive: true, force: true });
  }
}, 185000);
