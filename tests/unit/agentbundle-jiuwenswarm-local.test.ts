import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandSpec, EnvironmentSession, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import { verifyBundleCandidate } from "../../src/runtimes/agentbundle/sdk.js";
import { JIUWENSWARM_VERSION } from "../../src/runtimes/jiuwenswarm/runtime.js";
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

function fakeLocalSession(options: {
  verifyDigest?: string;
  runtimeRoot: string;
  stateRoot: string;
  jiuwenswarm: string;
}): {
  session: EnvironmentSession;
  started: CommandSpec[];
  solveSpec: () => CommandSpec | undefined;
} {
  const started: CommandSpec[] = [];
  let solve: CommandSpec | undefined;
  const installHome = () => {
    const args = started.at(-1)?.args ?? [];
    return args[args.indexOf("--home") + 1] ?? "";
  };
  const session: EnvironmentSession = {
    id: "local-1",
    workdir: "/workspace",
    agentOutputDir: "/logs/agent",
    verifierOutputDir: "/logs/verifier",
    metadata: {},
    runtime: {
      root: options.runtimeRoot,
      stateRoot: options.stateRoot,
      persistent: true,
      identity: "local-runtime-identity",
    },
    start: async spec => {
      started.push(spec);
      if (spec.executable === process.execPath) {
        if (spec.args.some(argument => argument === "verify"))
          return fakeHandle({ stdout: `${JSON.stringify({ digest: options.verifyDigest, harness: HARNESS })}\n` });
        if (spec.args.some(argument => argument === "install"))
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
        throw new Error(`unexpected CLI command: ${spec.args.join(" ")}`);
      }
      if (spec.executable === options.jiuwenswarm) {
        solve = spec;
        return fakeHandle({});
      }
      throw new Error(`unexpected command: ${spec.executable}`);
    },
    upload: async () => {
      throw new Error("upload must not be called: the bundle is read from the host path");
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

function localSolver(jiuwenswarmTimeoutSeconds?: number) {
  return new AgentBundleSolver(
    fixtureBundle,
    { ...model },
    { value: "secret-key", reference: null },
    { installation: async () => ({ id: "fixture-runtime", files: [], commands: [], probes: [] }) },
    { environmentName: "local", ...(jiuwenswarmTimeoutSeconds === undefined ? {} : { jiuwenswarmTimeoutSeconds }) },
  );
}

async function agentPaths(prefix: string): Promise<{ root: string; agent: string; runtimeRoot: string; stateRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const agent = join(root, "agent");
  const runtimeRoot = join(root, "runtime");
  const stateRoot = join(runtimeRoot, "state");
  await mkdir(agent, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  return { root, agent, runtimeRoot, stateRoot };
}

describe("agentbundle jiuwenswarm local preparation", () => {
  it.each([undefined, 1200])("launches UTF-8 jiuwenswarm-process with timeout override %s", async timeoutSeconds => {
    const digest = (await verifyBundleCandidate(fixtureBundle)).digest;
    const paths = await agentPaths("jiuwenswarm-local-");
    const jiuwenswarm = join(paths.root, "jiuwenswarm-process.exe");
    await writeFile(jiuwenswarm, "");
    await chmod(jiuwenswarm, 0o755);
    const previous = process.env["JIUWENSWARM_BIN"];
    process.env["JIUWENSWARM_BIN"] = jiuwenswarm;
    try {
      const { session, started, solveSpec } = fakeLocalSession({
        verifyDigest: digest,
        runtimeRoot: paths.runtimeRoot,
        stateRoot: paths.stateRoot,
        jiuwenswarm,
      });
      const solver = localSolver(timeoutSeconds);
      await solver.provenance(signal);
      const prepared = await solver.prepare(session, attemptContext(paths));
      await prepared.solve({ id: "test:0", prompt: "hello" }, attemptContext(paths)).catch(() => {});
      await prepared.dispose?.(signal);

      const verify = started.find(spec => spec.args.some(argument => argument === "verify"));
      expect(verify?.executable).toBe(process.execPath);
      expect(verify?.args[0]).toBe(join(paths.runtimeRoot, "agentbundle", "run.mjs"));
      expect(verify?.args).toContain("--expect-digest");
      expect(verify?.args).toContain(digest);
      expect(verify?.cwd).toBe(paths.runtimeRoot);
      expect(verify?.env).toMatchObject({ AGENT_MODEL_PROVIDER: "OpenAI", AGENT_MODEL_NAME: "gpt-fake" });

      const install = started.find(spec => spec.args.some(argument => argument === "install"));
      expect(install?.args).toContain("--home");
      const state = String(install?.args[(install?.args.indexOf("--home") ?? -1) + 1]);
      expect(state.startsWith(paths.stateRoot)).toBe(true);

      const solve = solveSpec();
      expect(solve?.executable).toBe(jiuwenswarm);
      expect(solve?.args).toEqual(["hello", "--output", "json", "--cwd", "/workspace", "--timeout", String(timeoutSeconds ?? 600)]);
      expect(solve?.cwd).toBe("/workspace");
      expect(solve?.env).toMatchObject({
        PYTHONIOENCODING: "utf-8",
        JIUWENSWARM_DATA_DIR: state,
        API_BASE: model.endpoint,
        API_KEY: "secret-key",
        MODEL_NAME: "gpt-fake",
        MODEL_PROVIDER: "OpenAI",
        ENDPOINT_PROFILE: "openai",
        HOME: state,
        USERPROFILE: state,
      });
      expect(solve?.inheritEnv).toBe(false);

      const installation = JSON.parse(await readFile(join(paths.agent, "installation.json"), "utf8"));
      expect(installation).toMatchObject({
        digest,
        harness: HARNESS,
        home: state,
        runtimeIdentity: "local-runtime-identity",
      });
    } finally {
      if (previous === undefined) delete process.env["JIUWENSWARM_BIN"];
      else process.env["JIUWENSWARM_BIN"] = previous;
      await rm(paths.root, { recursive: true, force: true });
    }
  });
});
