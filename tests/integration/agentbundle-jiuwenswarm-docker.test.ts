import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test, expect } from "vitest";

import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";
import {
  JIUWENSWARM_PROCESS_CLI_NAME,
  JIUWENSWARM_VERSION,
  jiuwenswarmDockerRuntimeInstallation,
} from "../../src/runtimes/jiuwenswarm/runtime.js";
import { resolveLinuxUvBinary } from "../../src/infrastructure/runtime-installation/uv-binary.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import type { CommandSpec, EnvironmentSession } from "../../src/core/contracts/environment.js";
import type { JsonValue } from "../../src/core/contracts/task.js";

const fixtureBundle = join(import.meta.dirname, "..", "fixtures", "agentbundle", "jiuwenswarm");

const dockerEnabled = process.env.EVALUATOR_TEST_DOCKER === "1";
const checkout = process.env.JIUWENSWARM_CHECKOUT ?? "";
// The image build injects the host uv into a linux/x64 container, so the gate
// is the same resolution the docker installation performs.
const hostUv = await resolveLinuxUvBinary(AbortSignal.timeout(20_000), message => new Error(message))
  .then(() => true)
  .catch(() => false);

async function collect(
  session: EnvironmentSession,
  command: CommandSpec,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  const handle = await session.start(command, signal);
  const read = async (stream: AsyncIterable<Uint8Array>): Promise<string> => {
    let text = "";
    for await (const chunk of stream) text += new TextDecoder().decode(chunk);
    return text;
  };
  const [stdout, stderr, exit] = await Promise.all([read(handle.stdout), read(handle.stderr), handle.done]);
  return { stdout, stderr, code: exit.code, signal: exit.signal };
}

test.skipIf(!dockerEnabled || !hostUv || checkout === "")(
  "bakes the jiuwenswarm harness and installs the bundle inside the docker solver image",
  async () => {
    const signal = AbortSignal.timeout(1_800_000);
    const root = await mkdtemp(join(tmpdir(), "evaluator-jiuwenswarm-docker-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    try {
      const context = join(root, "task-context");
      await mkdir(context, { recursive: true });
      const dockerfile = join(context, "Dockerfile");
      await writeFile(dockerfile, "FROM debian:bookworm-slim\nRUN true\n");
      const manifest = await buildFileManifest(context, []);
      const sourceHash = fingerprintConfig(manifest.files as unknown as JsonValue);

      const installation = await jiuwenswarmDockerRuntimeInstallation(fixtureBundle, signal);
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
          { name: "fake-model", endpoint: "http://127.0.0.1:9/v1", provider: "fake", api: "openai-completions" },
          { value: "fake-key", reference: null },
          undefined,
          { environmentName: "docker" },
        );
        const paths = {
          root,
          agent: agentDir,
          verifier: join(root, "verifier"),
          artifacts: join(root, "artifacts"),
        };
        const prepared = await solver.prepare(session, {
          key: { runId: "run-it", taskId: "test:0", attemptId: "attempt-1" },
          paths,
          signal,
        });
        try {
          const recorded = JSON.parse(await readFile(join(agentDir, "installation.json"), "utf8"));
          expect(recorded).toMatchObject({
            reused: true,
            harnessVersion: JIUWENSWARM_VERSION,
            runtimeIdentity: session.runtime?.identity,
          });
          expect(recorded.home).toMatch(/^\/opt\/evaluator-agent\/state\/[a-f0-9]{24}$/u);

          // The baked venv must really execute the headless CLI in the container.
          const help = await collect(
            session,
            {
              executable: posix.join(recorded.home as string, "bin", JIUWENSWARM_PROCESS_CLI_NAME),
              args: ["--help"],
              cwd: "/workspace",
              env: {},
              input: null,
            },
            signal,
          );
          expect({ code: help.code, signal: help.signal }).toEqual({ code: 0, signal: null });
          expect(`${help.stdout}${help.stderr}`.trim()).not.toBe("");
        } finally {
          await prepared.dispose?.(AbortSignal.timeout(60_000));
        }
      } finally {
        await session.dispose(AbortSignal.timeout(60_000));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  1_900_000,
);
