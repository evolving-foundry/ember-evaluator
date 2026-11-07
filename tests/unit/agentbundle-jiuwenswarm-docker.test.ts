import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { CommandSpec, EnvironmentSession, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import { verifyBundleCandidate } from "../../src/runtimes/agentbundle/sdk.js";
import { JIUWENSWARM_PROCESS_CLI_MARKER, JIUWENSWARM_VERSION } from "../../src/runtimes/jiuwenswarm/runtime.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";

const fixtureBundle = join(import.meta.dirname, "..", "fixtures", "agentbundle", "jiuwenswarm");
const signal = new AbortController().signal;

const model = {
  name: "gpt-fake",
  endpoint: "http://model-endpoint.example:8080/v1",
  provider: null,
  api: "openai-completions",
} as const;

const HARNESS = { name: "jiuwenswarm", versionRange: ">=0.2,<0.3", actualVersion: JIUWENSWARM_VERSION };

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
  verifyDigest?: string;
  probeOutput?: string;
  persistent?: boolean;
  modelEndpoint?: { baseUrl: string; originEndpoint: string };
};

function fakeDockerSession(options: SessionOptions = {}): {
  session: EnvironmentSession;
  started: CommandSpec[];
  uploaded: string[];
  solveSpec: () => CommandSpec | undefined;
} {
  const started: CommandSpec[] = [];
  const uploaded: string[] = [];
  let solve: CommandSpec | undefined;
  const installHome = () => {
    const args = started.at(-1)?.args ?? [];
    return args[args.indexOf("--home") + 1] ?? "";
  };
  const session: EnvironmentSession = {
    id: "container-12",
    workdir: "/workspace",
    agentOutputDir: "/logs/agent",
    verifierOutputDir: "/logs/verifier",
    metadata: {},
    runtime: {
      root: "/opt/evaluator-agent",
      stateRoot: "/opt/evaluator-agent/state",
      persistent: options.persistent ?? false,
      identity: "docker-image-identity",
    },
    ...(options.modelEndpoint === undefined ? {} : { modelEndpoint: options.modelEndpoint }),
    start: async spec => {
      started.push(spec);
      if (spec.args.some(argument => argument === "verify")) {
        return fakeHandle({ stdout: `${JSON.stringify({ digest: options.verifyDigest, harness: HARNESS })}\n` });
      }
      if (spec.args.some(argument => argument === "install")) {
        return fakeHandle({
          stdout: `${JSON.stringify({
            digest: options.verifyDigest,
            harness: HARNESS,
            home: installHome(),
            profile: "ember-jw",
            reused: false,
            installationId: "ember-jw-01234567",
          })}\n`,
        });
      }
      if (spec.executable.endsWith("/bin/python")) {
        return fakeHandle({ stdout: `${options.probeOutput ?? JIUWENSWARM_PROCESS_CLI_MARKER}\n` });
      }
      if (spec.executable === "cat") return fakeHandle({ stdout: `preferred_language: zh\nmodels:\n  defaults:\n    - model_client_config:\n        timeout: 1800\n        custom_headers: {}\n      model_config_obj:\n        max_tokens: 32768\n        reasoning_effort: low\n        context_window: 262144\n` });
      if (spec.executable.endsWith("/bin/jiuwenswarm-process")) {
        solve = spec;
        return fakeHandle({});
      }
      throw new Error(`unexpected command: ${spec.executable} ${spec.args.join(" ")}`);
    },
    upload: async (source, target) => {
      if (!target.endsWith("/config/config.yaml")) throw new Error("only model config overlay may be uploaded");
      uploaded.push(await readFile(source, "utf8"));
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
  return { session, started, solveSpec: () => solve, uploaded };
}

function attemptContext(paths: { root: string; agent: string }): AttemptContext {
  return {
    key: { runId: "run-1", taskId: "test:0", attemptId: "attempt-1" },
    paths: { ...paths, verifier: join(paths.root, "verifier"), artifacts: join(paths.root, "artifacts") },
    signal,
  };
}

function dockerSolver(jiuwenswarmTimeoutSeconds?: number) {
  return new AgentBundleSolver(
    fixtureBundle,
    { ...model },
    { value: "secret-key", reference: null },
    { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
    { environmentName: "docker", ...(jiuwenswarmTimeoutSeconds === undefined ? {} : { jiuwenswarmTimeoutSeconds }) },
  );
}

async function agentPaths(prefix: string): Promise<{ root: string; agent: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const agent = join(root, "agent");
  await mkdir(agent, { recursive: true });
  return { root, agent };
}

describe("agentbundle jiuwenswarm docker preparation", () => {
  it.each([undefined, 1200])("prepares the baked bundle and launches with timeout override %s", async timeoutSeconds => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session, started, solveSpec, uploaded } = fakeDockerSession({
      verifyDigest: digest,
      modelEndpoint: { baseUrl: "http://127.0.0.1:9090/v1", originEndpoint: model.endpoint },
    });
    const solver = dockerSolver(timeoutSeconds);
    await solver.provenance(signal);
    const paths = await agentPaths("jiuwenswarm-docker-");
    try {
      const prepared = await solver.prepare(session, attemptContext(paths));
      expect(uploaded).toHaveLength(1);
      const installed = parseYaml(uploaded[0]!) as { preferred_language: string; models: { defaults: {
        model_client_config: Record<string, unknown>; model_config_obj: Record<string, unknown>;
      }[] } };
      expect(installed.preferred_language).toBe("zh");
      expect(installed.models.defaults[0]!.model_config_obj).toEqual({ max_tokens: 32768,
        reasoning_effort: "low", context_window: 262144 });
      expect(installed.models.defaults[0]!.model_client_config).toMatchObject({ timeout: 300,
        stream_first_chunk_timeout: 180, stream_idle_timeout: 120, custom_headers: {} });
      expect(uploaded[0]).not.toContain("secret-key");
      // An empty protocol stream makes consumeJiuwenswarm fail, which is fine here.
      await prepared.solve({ id: "test:0", prompt: "hello" }, attemptContext(paths)).catch(() => {});
      await prepared.dispose?.(signal);

      const verify = started.find(spec => spec.args.some(argument => argument === "verify"));
      expect(verify?.executable).toBe("node");
      expect(verify?.args[0]).toBe("/opt/evaluator-agent/agentbundle/run.mjs");
      expect(verify?.args).toContain("--expect-digest");
      expect(verify?.args).toContain(digest);
      expect(verify?.cwd).toBe("/opt/evaluator-agent");
      expect(verify?.env).toMatchObject({ AGENT_MODEL_PROVIDER: "OpenAI", AGENT_MODEL_NAME: "gpt-fake" });

      const install = started.find(spec => spec.args.some(argument => argument === "install"));
      expect(install?.executable).toBe("node");
      expect(install?.args).toContain("install");
      expect(install?.args).toContain("--home");
      const state = String(install?.args[(install?.args.indexOf("--home") ?? -1) + 1]);
      expect(state.startsWith("/opt/evaluator-agent/state/")).toBe(true);

      const probe = started.find(spec => spec.executable.endsWith("/bin/python"));
      expect(probe?.executable).toBe("/opt/evaluator-agent/jiuwenswarm/home/bin/python");

      const solve = solveSpec();
      expect(solve?.executable).toBe("/opt/evaluator-agent/jiuwenswarm/home/bin/jiuwenswarm-process");
      expect(solve?.args).toEqual(["hello", "--output", "json", "--cwd", "/workspace", "--timeout", String(timeoutSeconds ?? 600)]);
      expect(solve?.cwd).toBe("/workspace");
      expect(solve?.env).toMatchObject({
        JIUWENSWARM_DATA_DIR: state,
        API_BASE: "http://127.0.0.1:9090/v1",
        API_KEY: "secret-key",
        MODEL_NAME: "gpt-fake",
        MODEL_PROVIDER: "OpenAI",
        ENDPOINT_PROFILE: "openai",
        HOME: state,
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      });

      const installation = JSON.parse(await readFile(join(paths.agent, "installation.json"), "utf8"));
      expect(installation).toMatchObject({
        digest,
        harness: HARNESS,
        home: state,
        reused: true,
        harnessVersion: JIUWENSWARM_VERSION,
        runtimeIdentity: "docker-image-identity",
      });
      expect(installation.preparationIdentity).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("keeps the configured endpoint when the environment does not map the model API", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session, solveSpec } = fakeDockerSession({ verifyDigest: digest });
    const solver = dockerSolver();
    await solver.provenance(signal);
    const paths = await agentPaths("jiuwenswarm-docker-unmapped-");
    try {
      const prepared = await solver.prepare(session, attemptContext(paths));
      await prepared.solve({ id: "test:0", prompt: "hello" }, attemptContext(paths)).catch(() => {});
      await prepared.dispose?.(signal);
      expect(solveSpec()?.env.API_BASE).toBe(model.endpoint);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("fails when the image carries no headless process CLI", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session } = fakeDockerSession({ verifyDigest: digest, probeOutput: "ModuleNotFoundError" });
    const solver = dockerSolver();
    await solver.provenance(signal);
    const paths = await agentPaths("jiuwenswarm-docker-probe-");
    try {
      await expect(solver.prepare(session, attemptContext(paths))).rejects.toMatchObject({
        code: "SOURCE_CHANGED",
      });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it.each(["\n", "\r\n"])("accepts SDK initialization logs before the final CLI marker (%j)", async newline => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session } = fakeDockerSession({
      verifyDigest: digest,
      probeOutput: `INFO Registered connector pool${newline}${JIUWENSWARM_PROCESS_CLI_MARKER}${newline}`,
    });
    const solver = dockerSolver();
    await solver.provenance(signal);
    const paths = await agentPaths("jiuwenswarm-docker-probe-logs-");
    try {
      const prepared = await solver.prepare(session, attemptContext(paths));
      expect(JSON.parse(await readFile(join(paths.agent, "installation.json"), "utf8"))).toMatchObject({ digest });
      await prepared.dispose?.(signal);
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("rejects a probe error after an earlier success marker", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const { session } = fakeDockerSession({
      verifyDigest: digest,
      probeOutput: `${JIUWENSWARM_PROCESS_CLI_MARKER}\nModuleNotFoundError`,
    });
    const solver = dockerSolver();
    await solver.provenance(signal);
    const paths = await agentPaths("jiuwenswarm-docker-probe-trailing-");
    try {
      await expect(solver.prepare(session, attemptContext(paths))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("rejects a verify digest that differs from the locked candidate", async () => {
    const { session } = fakeDockerSession({ verifyDigest: "sha256:" + "0".repeat(64) });
    const solver = dockerSolver();
    await solver.provenance(signal);
    const paths = await agentPaths("jiuwenswarm-docker-digest-");
    try {
      await expect(solver.prepare(session, attemptContext(paths))).rejects.toMatchObject({
        code: "SOURCE_CHANGED",
      });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("rejects a persistent runtime and the DSH-only home options", async () => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const paths = await agentPaths("jiuwenswarm-docker-local-");
    try {
      const local = fakeDockerSession({ verifyDigest: digest, persistent: true });
      await expect(dockerSolver().prepare(local.session, attemptContext(paths))).rejects.toMatchObject({
        code: "ENV_RUNTIME_INSTALL_FAILED",
      });
      const withDshHome = new AgentBundleSolver(
        fixtureBundle,
        { ...model },
        { value: "secret-key", reference: null },
        { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
        { environmentName: "docker", dshhome: "/tmp/dsh-home" },
      );
      await withDshHome.provenance(signal);
      const docker = fakeDockerSession({ verifyDigest: digest });
      await expect(withDshHome.prepare(docker.session, attemptContext(paths))).rejects.toMatchObject({
        code: "ENV_RUNTIME_INSTALL_FAILED",
      });
    } finally {
      await rm(paths.root, { recursive: true, force: true });
    }
  });

  it("declares node only for the docker jiuwenswarm combination", async () => {
    const docker = dockerSolver();
    await docker.provenance(signal);
    expect(docker.requirements()).toEqual([
      { name: "node", version: "24.x", platform: "any" },
      { name: "shell", version: "any", platform: "any" },
    ]);
    const local = new AgentBundleSolver(
      fixtureBundle,
      { ...model },
      { value: "secret-key", reference: null },
      { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
    );
    await local.provenance(signal);
    expect(local.requirements()).toEqual([{ name: "shell", version: "any", platform: "any" }]);
  });
});
