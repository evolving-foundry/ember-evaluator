import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER } from "../../src/infrastructure/containers/runtime-contract.js";
import { DockerSolverRuntime } from "../../src/infrastructure/containers/solver-runtime.js";
import { startDockerProcess } from "../../src/infrastructure/containers/process.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { readProcess } from "../../src/infrastructure/process/output.js";

const exec = promisify(execFile);

test.skipIf(process.env.EVALUATOR_COMPOSE_DOCKER_TESTS !== "1")("a shadowing task Node does not replace the framework runtime or its probes", async () => {
  const signal = AbortSignal.timeout(180_000);
  const base = process.env.EVALUATOR_COMPOSE_TEST_TMP ?? tmpdir();
  await mkdir(base, { recursive: true });
  const context = await mkdtemp(join(base, "node-path-"));
  const tag = `evaluator-node-path-regression:${process.pid}`;
  let container: string | undefined;
  const command = (args: string[], options?: { signal?: AbortSignal; maxBuffer?: number }) => runDockerCommand("docker", args, options);
  try {
    const platform = (await exec("docker", ["version", "--format", "{{.Server.Arch}}"])).stdout.trim() === "arm64" ? "linux/arm64" : "linux/amd64";
    const node = new DockerRuntime(command, undefined, platform);
    await node.nodeImageDigest(signal);
    await writeFile(join(context, "Dockerfile"), `FROM ${node.nodeImage}\nRUN mkdir -p /opt/conda/bin && printf '#!/bin/sh\\necho shadow-node\\nexit 73\\n' > /opt/conda/bin/node && chmod 755 /opt/conda/bin/node\nENV PATH=/opt/conda/bin:$PATH\n`);
    await exec("docker", ["build", "--platform", platform, "--tag", tag, context], { signal });
    const prepared = await node.prepare(tag, [{ name: "node", version: "24.x", platform }], signal);
    await writeFile(join(context, "package.json"), "{}");
    const solver = await new DockerSolverRuntime(command, node).prepare(prepared.image, prepared.digest, {
      id: "shadow-node-regression", files: [{ source: join(context, "package.json"), target: "package.json" }], commands: [],
      probes: [{ executable: "node", args: ["-e", "if(!process.version.startsWith('v24.'))process.exit(74)"] }],
    }, signal);
    container = (await exec("docker", ["run", "--detach", "--network", "none", "--entrypoint", EVALUATOR_NODE_EXECUTABLE, solver.image, PROCESS_HELPER, "idle"], { signal })).stdout.trim();
    const execute = async (executable: string, args: string[]) => readProcess(await startDockerProcess({
      dockerExecutable: "docker", containerId: container ?? "", command,
    }, { executable, args, cwd: "/", env: {}, input: null }, signal), signal);
    const trusted = await execute("node", ["--version"]);
    expect(trusted.code).toBe(0);
    expect(trusted.stdout.trim()).toMatch(/^v24\./u);
    const taskNode = await execute("/bin/sh", ["-c", "node --version"]);
    expect(taskNode.code).toBe(73);
    expect(taskNode.stdout.trim()).toBe("shadow-node");
  } finally {
    if (container) await exec("docker", ["rm", "--force", container]).catch(() => undefined);
    await exec("docker", ["image", "rm", tag]).catch(() => undefined);
    await rm(context, { recursive: true, force: true });
  }
}, 185_000);
