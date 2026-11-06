import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test, expect } from "vitest";

import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";
import { deepagentsDockerRuntimeInstallation } from "../../src/runtimes/deepagents/runtime.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import type { JsonValue } from "../../src/core/contracts/task.js";

const execFileAsync = promisify(execFile);
const fixtureBundle = join(import.meta.dirname, "..", "fixtures", "agentbundle", "deepagents");

const dockerEnabled = process.env.EVALUATOR_TEST_DOCKER === "1";
const hostUv = await promisify(execFile)("uv", ["--version"])
  .then(() => true)
  .catch(() => false);

test.skipIf(!dockerEnabled || !hostUv)(
  "solves a deepagents bundle inside the docker task container end to end",
  async () => {
    const signal = AbortSignal.timeout(900_000);
    const marker = `docker-fixture-marker-${Date.now()}`;
    const root = await mkdtemp(join(tmpdir(), "evaluator-deepagents-docker-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    try {
      // Minimal task image: the deepagents runtime (node, uv, CPython, venv and
      // the bundle) is layered on top by the environment's solver image build.
      const context = join(root, "task-context");
      await mkdir(context, { recursive: true });
      const dockerfile = join(context, "Dockerfile");
      await writeFile(dockerfile, "FROM debian:bookworm-slim\nRUN true\n");
      const manifest = await buildFileManifest(context, []);
      const sourceHash = fingerprintConfig(manifest.files as unknown as JsonValue);

      const installation = await deepagentsDockerRuntimeInstallation(fixtureBundle, signal);
      const environment = new DockerEnvironment({ platform: "linux/amd64" });
      const session = await environment.prepare(
        {
          workdir: "/workspace",
          image: null,
          initialFiles: [],
          build: { context, dockerfile, sourceHash },
          runtime: [
            { name: "node", version: "24.x", platform: "any" },
            { name: "shell", version: "any", platform: "any" },
          ],
          installation,
        },
        { root, agent: agentDir, verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
        "solve",
        signal,
      );
      try {
        expect(session.runtime).toMatchObject({
          root: "/opt/evaluator-agent",
          stateRoot: "/opt/evaluator-agent/state",
          persistent: false,
        });
        expect(session.metadata).toMatchObject({ kind: "docker", platform: "linux/amd64" });

        const solver = new AgentBundleSolver(
          fixtureBundle,
          { name: "fake-model", endpoint: null, provider: "fake", api: "openai-completions" },
          { value: "", reference: null },
          undefined,
          { environmentName: "docker" },
        );
        const prepared = await solver.prepare(
          session,
          {
            key: { runId: "run-it", taskId: "test:0", attemptId: "attempt-1" },
            paths: { root, agent: agentDir, verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
            signal,
          },
        );
        const result = await prepared.solve({ id: "test:0", prompt: marker }, {
          key: { runId: "run-it", taskId: "test:0", attemptId: "attempt-1" },
          paths: { root, agent: agentDir, verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
          signal,
        });
        expect(result.finalText).toContain(`Answer: ${marker}`);
        // Fixture script: step 1 (in 5/out 4/total 9, no cache details) and
        // step 2 (in 11/out 7/total 18, cache 3/2) — input stays unknown.
        expect(result.usage).toEqual({ inputTokens: null, outputTokens: 11, totalTokens: 27 });

        // The fixture graph's write_file round-trip must have landed in the
        // container task workspace (LocalShellBackend, cwd = workdir).
        const markerPath = join(root, "marker.txt");
        await session.download("/workspace/marker.txt", markerPath, signal);
        expect(await readFile(markerPath, "utf8")).toBe(marker);
      } finally {
        await session.dispose(AbortSignal.timeout(10_000));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  920_000,
);
