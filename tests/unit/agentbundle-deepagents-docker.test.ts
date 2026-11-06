import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandSpec, EnvironmentSession, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import { verifyBundleCandidate } from "../../src/runtimes/agentbundle/sdk.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";

const fixtureBundle = join(import.meta.dirname, "..", "fixtures", "agentbundle", "deepagents");
const signal = new AbortController().signal;

const model = {
  name: "gpt-fake",
  endpoint: "http://model-endpoint.example:8080/v1",
  provider: null,
  api: "openai-completions",
} as const;

function fakeHandle(output: { stdout?: string }): ProcessHandle {
  const bytes = output.stdout === undefined ? [] : [new TextEncoder().encode(output.stdout)];
  async function* stdout() {
    for (const chunk of bytes) yield chunk;
  }
  async function* stderr() {}
  return {
    stdout: stdout(),
    stderr: stderr(),
    done: Promise.resolve({ code: 0, signal: null }),
    stop: async () => {},
  };
}

type SessionOptions = {
  runtimeIdentity?: string;
  verifyDigest?: string;
  probeVersion?: string;
  modelEndpoint?: { baseUrl: string; originEndpoint: string };
};

function fakeDockerSession(options: SessionOptions = {}): {
  session: EnvironmentSession;
  started: CommandSpec[];
  solveSpec: () => CommandSpec | undefined;
} {
  const started: CommandSpec[] = [];
  let solve: CommandSpec | undefined;
  const session: EnvironmentSession = {
    id: "container-12",
    workdir: "/workspace",
    agentOutputDir: "/logs/agent",
    verifierOutputDir: "/logs/verifier",
    metadata: {},
    runtime: {
      root: "/opt/evaluator-agent",
      stateRoot: "/opt/evaluator-agent/state",
      persistent: false,
      identity: options.runtimeIdentity ?? "docker-image-identity",
    },
    ...(options.modelEndpoint === undefined ? {} : { modelEndpoint: options.modelEndpoint }),
    start: async spec => {
      started.push(spec);
      if (spec.args.some(argument => argument === "verify")) {
        return fakeHandle({
          stdout: `${JSON.stringify({
            digest: options.verifyDigest,
            harness: { name: "deepagents", versionRange: ">=0.7,<0.8", actualVersion: "0.7.15" },
          })}\n`,
        });
      }
      if (spec.executable.endsWith("/bin/python") && spec.args[0]?.startsWith("-c")) {
        const code = spec.args.join(" ");
        return fakeHandle({
          stdout: `${code.includes("certifi")
            ? "/opt/evaluator-agent/deepagents/home/lib/python3.12/site-packages/certifi/cacert.pem"
            : options.probeVersion ?? "0.7.15"}\n`,
        });
      }
      if (spec.executable.endsWith("/bin/python")) {
        solve = spec;
        return fakeHandle({});
      }
      throw new Error(`unexpected command: ${spec.executable} ${spec.args.join(" ")}`);
    },
    upload: async () => {
      throw new Error("upload must not be called: the bundle is baked into the image");
    },
    download: async () => {
      throw new Error("download must not be called");
    },
    exportState: async () => {
      throw new Error("exportState must not be called");
    },
    restoreState: async () => {
      throw new Error("restoreState must not be called");
    },
    dispose: async () => {},
  };
  return { session, started, solveSpec: () => solve };
}

function attemptContext(paths: { root: string; agent: string }): AttemptContext {
  return {
    key: { runId: "run-1", taskId: "test:0", attemptId: "attempt-1" },
    paths: { ...paths, verifier: join(paths.root, "verifier"), artifacts: join(paths.root, "artifacts") },
    signal,
  };
}

describe("agentbundle deepagents docker preparation", () => {
  it("verifies the baked bundle, records installation evidence and returns the container solve handle", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session, started, solveSpec } = fakeDockerSession({
      verifyDigest: digest,
      modelEndpoint: { baseUrl: "http://127.0.0.1:9090/v1", originEndpoint: model.endpoint },
    });
    const paths = { root: await mkdtemp(join(tmpdir(), "deepagents-docker-prepare-")), agent: "" };
    paths.agent = join(paths.root, "agent");
    await mkdir(paths.agent, { recursive: true });
    try {
      const solver = new AgentBundleSolver(
        fixtureBundle,
        { ...model },
        { value: "secret-key", reference: null },
        { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
        { environmentName: "docker" },
      );
      const provenance = await solver.provenance(signal);
      expect(provenance).toMatchObject({
        harness: "deepagents",
        harnessVersion: "0.7.15",
        pythonRuntime: "docker uv-managed cpython 3.12 (provisioned in the solver image)",
      });
      const prepared = await solver.prepare(session, attemptContext(paths));
      expect(prepared.dispose).toBeDefined();
      // The solve command only launches through the prepared handle; an empty
      // protocol stream makes consumeDsh fail, which is fine for this unit.
      await prepared.solve({ id: "test:0", prompt: "hello" }, attemptContext(paths)).catch(() => {});
      await prepared.dispose?.(signal);

      const verify = started.find(spec => spec.args.some(argument => argument === "verify"));
      expect(verify?.executable).toBe("node");
      expect(verify?.args[0]).toBe("/opt/evaluator-agent/agentbundle/run.mjs");
      expect(verify?.args).toContain("--expect-digest");
      expect(verify?.args).toContain(digest);
      expect(verify?.cwd).toBe("/opt/evaluator-agent");

      const probe = started.find(spec => spec.executable.endsWith("/bin/python") && spec.args[0]?.startsWith("-c"));
      expect(probe?.executable).toBe("/opt/evaluator-agent/deepagents/home/bin/python");

      const solve = solveSpec();
      expect(solve?.executable).toBe("/opt/evaluator-agent/deepagents/home/bin/python");
      expect(solve?.args).toEqual([
        "/opt/evaluator-agent/deepagents/runner.py",
        "--bundle-dir",
        "/opt/evaluator-agent/bundle",
        "--json",
      ]);
      expect(solve?.cwd).toBe("/workspace");
      expect(solve?.env).toMatchObject({
        AGENT_MODEL_PROVIDER: "openai",
        AGENT_MODEL_NAME: "gpt-fake",
        OPENAI_BASE_URL: "http://127.0.0.1:9090/v1",
        OPENAI_API_KEY: "secret-key",
        HOME: "/tmp",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        SSL_CERT_FILE: "/opt/evaluator-agent/deepagents/home/lib/python3.12/site-packages/certifi/cacert.pem",
      });

      const installation = JSON.parse(await readFile(join(paths.agent, "installation.json"), "utf8"));
      expect(installation).toMatchObject({
        digest,
        harness: { name: "deepagents", versionRange: ">=0.7,<0.8", actualVersion: "0.7.15" },
        home: "/opt/evaluator-agent/deepagents/home",
        profile: "evaluator-fixture",
        reused: true,
        installationId: `evaluator-fixture-${digest.slice("sha256:".length, "sha256:".length + 8)}`,
        runtimeIdentity: "docker-image-identity",
      });
      expect(installation.preparationIdentity).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("fails the probe when the image carries a different deepagents version", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session } = fakeDockerSession({ verifyDigest: digest, probeVersion: "0.7.14" });
    const solver = new AgentBundleSolver(
      fixtureBundle,
      { ...model },
      { value: "secret-key", reference: null },
      { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
      { environmentName: "docker" },
    );
    await solver.provenance(signal);
    const paths = { root: await mkdtemp(join(tmpdir(), "deepagents-docker-probe-")), agent: "" };
    paths.agent = join(paths.root, "agent");
    await mkdir(paths.agent, { recursive: true });
    try {
      await expect(solver.prepare(session, attemptContext(paths))).rejects.toMatchObject({
        code: "SOURCE_CHANGED",
      });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("rejects a verify digest that differs from the locked candidate", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session } = fakeDockerSession({ verifyDigest: "sha256:" + "0".repeat(64) });
    const solver = new AgentBundleSolver(
      fixtureBundle,
      { ...model },
      { value: "secret-key", reference: null },
      { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
      { environmentName: "docker" },
    );
    await solver.provenance(signal);
    const paths = { root: await mkdtemp(join(tmpdir(), "deepagents-docker-digest-")), agent: "" };
    paths.agent = join(paths.root, "agent");
    await mkdir(paths.agent, { recursive: true });
    try {
      await expect(solver.prepare(session, attemptContext(paths))).rejects.toMatchObject({
        code: "SOURCE_CHANGED",
      });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});
