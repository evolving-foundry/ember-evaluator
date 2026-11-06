import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RuntimeInstallation } from "../../src/core/contracts/environment.js";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { DockerSolverRuntime } from "../../src/infrastructure/containers/solver-runtime.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "shared runtime permissions allow different task users to read, execute and write separate state",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "evaluator-solver-permissions-"));
    const name = `evaluator-permissions-${randomUUID()}`;
    const images: string[] = [];
    let installations = 0;
    const signal = AbortSignal.timeout(180_000);
    const command: DockerCommand = async (args, options) => {
      if (args[0] === "build") {
        const image = args[args.indexOf("--tag") + 1]!;
        images.push(image);
        if (image.includes(":solver-install-")) installations++;
      }
      if (args[0] === "image" && args[1] === "tag") images.push(args[3]!);
      return runDockerCommand("docker", args, options);
    };
    const setup = [
      "const fs = require('node:fs');",
      "fs.mkdirSync('private/bin', { recursive: true, mode: 0o700 });",
      "fs.chmodSync('private', 0o700);",
      "fs.writeFileSync('private/value', 'fixture', { mode: 0o600 });",
      "fs.writeFileSync('private/bin/check', '#!/bin/sh\\nprintf ok', { mode: 0o700 });",
    ].join("\n");
    const probe = [
      "const fs = require('node:fs');",
      "const { execFileSync } = require('node:child_process');",
      "if (fs.readFileSync('private/value', 'utf8') !== 'fixture') throw Error('read failed');",
      "if (execFileSync('./private/bin/check', { encoding: 'utf8' }) !== 'ok') throw Error('execute failed');",
    ].join("\n");
    const installation: RuntimeInstallation = {
      id: name, files: [], commands: [{ executable: "node", args: ["-e", setup] }],
      probes: [{ executable: "node", args: ["-e", probe] }],
    };
    const node = new DockerRuntime(command);
    const solver = new DockerSolverRuntime(command, node);
    try {
      for (const user of ["1001:1002", "2001:2002"]) {
        const base = `${name}:${user.replace(":", "-")}`;
        await writeFile(join(directory, "Dockerfile"), `FROM ${PINNED_NODE_IMAGE}\nUSER ${user}\n`);
        await command(["build", "--platform", "linux/amd64", "--tag", base, directory], { signal });
        const runtime = await node.prepare(base, [], signal);
        const prepared = await solver.prepare(runtime.image, runtime.digest, installation, signal);
        const check = [
          "const fs = require('node:fs');",
          `if (process.getuid() !== ${user.split(":")[0]}) throw Error('wrong user');`,
          "const state = '/opt/evaluator-agent/state';",
          "if ((fs.statSync(state).mode & 0o7777) !== 0o1777) throw Error('wrong state permissions');",
          "if (fs.existsSync(state + '/marker')) throw Error('state leaked between containers');",
          "fs.writeFileSync(state + '/marker', 'ok');",
          "try { fs.accessSync('/opt/evaluator-agent/private/value', fs.constants.W_OK); throw Error('runtime is writable'); }",
          "catch (error) { if (error.code !== 'EACCES') throw error; }",
          `{ ${probe} }`,
          "console.log('permissions passed');",
        ].join("\n");
        const result = await command([
          "run", "--rm", "--network", "none", "--platform", "linux/amd64",
          "--workdir", "/opt/evaluator-agent", "--entrypoint", "/usr/local/bin/node",
          prepared.image, "-e", check,
        ], { signal });
        expect(result.stdout.trim()).toBe("permissions passed");
      }
      expect(installations).toBe(1);
    } finally {
      if (images.length) await runDockerCommand("docker", ["image", "rm", "--force", ...new Set(images.reverse())], { signal: AbortSignal.timeout(30_000) });
      await rm(directory, { recursive: true, force: true });
    }
  }, 210_000,
);
