import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1").each(["solve", "verify"] as const)(
  "%s exposes the task CPU budget to nproc and Node, including children and restart",
  async phase => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-docker-cpu-"));
    const dockerExecutable = process.env.EVALUATOR_TEST_DOCKER_EXECUTABLE ?? "docker";
    const environment = new DockerEnvironment({ dockerExecutable });
    try {
      const signal = AbortSignal.timeout(150_000);
      const ready = await environment.materialize({
        workdir: "/workspace", image: process.env.EVALUATOR_TEST_DOCKER_IMAGE ?? PINNED_NODE_IMAGE,
        initialFiles: [], runtime: [], resources: { cpus: 2, memory: "8192m" },
      }, signal);
      const session = await environment.prepare(ready,
        { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") }, phase, signal);
      try {
        expect(session.metadata).toMatchObject({ resources: { effective: { cpus: 2, availableCpus: 2 } } });
        const source = `import os, {cpus,availableParallelism} from "node:os";import {execFileSync} from "node:child_process";`
          + `console.log(JSON.stringify({nproc:Number(execFileSync("nproc",[],{encoding:"utf8"}).trim()),esm:cpus().length,default:os.cpus().length,`
          + `available:availableParallelism(),child:Number(execFileSync(process.execPath,["-p","require('node:os').cpus().length"],{encoding:"utf8"}).trim())}));`;
        const check = async () => {
          const response = await runDockerCommand(dockerExecutable,
            ["exec", session.id, "node", "--input-type=module", "-e", source], { signal });
          expect(JSON.parse(response.stdout)).toEqual({ nproc: 2, esm: 2, default: 2, available: 2, child: 2 });
        };
        await check();
        await session.quiesce?.(signal);
        await check();
      } finally { await session.dispose(AbortSignal.timeout(60_000)); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 220_000,
);
