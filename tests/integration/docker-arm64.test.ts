import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";

import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "prepares an amd64 solver container and maps the host model endpoint",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-docker-platform-"));
    const environment = new DockerEnvironment({ platform: "linux/amd64", modelEndpoint: "http://127.0.0.1:4000/v1" });
    const signal = AbortSignal.timeout(120_000);
    try {
      const session = await environment.prepare(
        {
          workdir: "/workspace",
          image: process.env.EVALUATOR_TEST_DOCKER_IMAGE ?? PINNED_NODE_IMAGE,
          initialFiles: [],
          runtime: [
            { name: "node", version: "24.x", platform: "any" },
            { name: "shell", version: "any", platform: "any" },
          ],
          installation: { id: "platform-smoke", files: [], commands: [], probes: [] },
        },
        {
          root,
          agent: join(root, "agent"),
          verifier: join(root, "verifier"),
          artifacts: join(root, "artifacts"),
        },
        "solve",
        signal,
      );
      try {
        expect(session.metadata).toMatchObject({ kind: "docker", platform: "linux/amd64" });
        const inspected = await runDockerCommand("docker", ["inspect", session.id, "--format", "{{.HostConfig.Init}}"], { signal });
        expect(inspected.stdout.trim()).toBe("true");
      } finally {
        await session.dispose(AbortSignal.timeout(10_000));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  130_000,
);

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "materialized Docker starts by image ID and quiesce stops detached writers before export",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-batch-docker-"));
    const environment = new DockerEnvironment();
    const signal = AbortSignal.timeout(120_000);
    try {
      const ready = await environment.materialize({
        workdir: "/workspace", image: PINNED_NODE_IMAGE, initialFiles: [],
        runtime: [{ name: "node", version: "24.x", platform: "any" }],
      }, signal, undefined, undefined, { taskId: "fixture/readable-image", phase: "solve" });
      expect(ready.prepared).toMatchObject({
        baseImage: { pinnedReference: expect.stringMatching(/^ember-evaluator\/readable-image:solve-base-[a-f0-9]{24}$/u) },
        runtime: { image: expect.stringMatching(/^ember-evaluator\/readable-image:solve-runtime-[a-f0-9]{24}$/u) },
      });
      const reused = await new DockerEnvironment().materialize({
        workdir: "/workspace", image: PINNED_NODE_IMAGE, initialFiles: [], runtime: [],
      }, signal, undefined, undefined, { taskId: "fixture/readable-image", phase: "solve" });
      expect(reused.preparationTiming?.cache?.runtime).toBe("image");
      const session = await environment.prepare(ready,
        { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
        "solve", signal);
      try {
        await runDockerCommand("docker", ["exec", "--detach", session.id, "node", "-e",
          "const fs=require('node:fs');fs.writeFileSync('/workspace/counter','started');setInterval(()=>fs.appendFileSync('/workspace/counter','x'),10)"], { signal });
        // Observe that the untracked writer really started before quiescing it.
        await runDockerCommand("docker", ["exec", session.id, "node", "-e",
          "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('/workspace/counter')){clearInterval(timer)}},10);setTimeout(()=>process.exit(fs.existsSync('/workspace/counter')?0:1),500)"], { signal });
        await session.quiesce!(signal);
        await expect(session.start({ executable: "node", args: ["--version"], cwd: "/workspace", env: {}, input: null }, signal))
          .rejects.toThrow(/quiesced/);
        const check = await runDockerCommand("docker", ["exec", session.id, "node", "-e",
          "const fs=require('node:fs');const before=fs.readFileSync('/workspace/counter','utf8');setTimeout(()=>{if(fs.readFileSync('/workspace/counter','utf8')!==before)process.exit(1);console.log('stable')},250)"], { signal });
        expect(check.stdout.trim()).toBe("stable");
        const archive = await session.exportState({ kind: "workspace-archive", workdir: "/workspace", extraPaths: [] }, join(root, "workspace.tar"), signal);
        expect(archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
      } finally { await session.dispose(AbortSignal.timeout(10_000)); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 130_000,
);
