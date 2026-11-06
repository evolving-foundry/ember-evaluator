import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import type { AttemptContext, ProcessHandle } from "../../src/index.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { consumeHermes } from "../../src/runtimes/hermes/protocol.js";

const exec = promisify(execFile);
const python = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
const roots: string[] = [];
async function context(): Promise<AttemptContext> {
  const root = await mkdtemp(join(tmpdir(), "harness-output-"));
  roots.push(root);
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  return { key: { runId: "r", taskId: "t", attemptId: "a" }, paths, signal: AbortSignal.timeout(10_000) };
}
function handle(stdout: string, code: number): ProcessHandle {
  return { stdout: (async function* () { yield Buffer.from(stdout); })(), stderr: (async function* () {})(),
    done: Promise.resolve({ code, signal: null }), async stop() {} };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(["length", "max_tokens", "empty", "stop"])("DeepAgents runner preserves %s terminal output", async reason => {
  const value = await context();
  await writeFile(join(value.paths.root, "agent.py"), `
from types import SimpleNamespace
def build_agent(middleware):
    message = SimpleNamespace(type="ai", content=${reason === "empty" ? '""' : '"partial"'}, tool_calls=[],
        usage_metadata={"input_tokens": 3, "output_tokens": 8},
        response_metadata={"finish_reason": "${reason === "empty" ? "length" : reason}"})
    return SimpleNamespace(invoke=lambda state: {"messages": [message]})
`);
  // The real runner owns stdin; use a small Python launcher to supply it.
  const { stdout } = await exec(python, ["-c", "import io,runpy,sys;sys.stdin=io.StringIO('task');sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')",
    resolve("src/runtimes/deepagents/assets/runner.py"), "--bundle-dir", value.paths.root],
  { cwd: value.paths.root, signal: value.signal, encoding: "utf8" });
  const warnings: unknown[] = [];
  const result = await consumeDsh(handle(stdout, 0), { ...value, warning: warning => warnings.push(warning) }, "", undefined, "DEEPAGENTS");
  expect(result.finalText).toBe(reason === "empty" ? "" : "partial");
  expect(warnings).toHaveLength(reason === "stop" ? 0 : 1);
  expect(stdout).toContain(`"kind": "${reason === "stop" ? "completed" : "max-tokens"}"`);
});

test.each(["length", "empty", "network", "no-reason", "auth", "cancelled", "context", "retry", "later-error", "report-error"])(
  "Hermes output capture preserves %s outcome", async scenario => {
    const value = await context();
    const report = join(value.paths.agent, "usage.json");
    const { stdout } = await exec(python, [resolve("tests/fixtures/hermes-output-capture.py"),
      resolve("src/runtimes/hermes/assets/runner.py"), report, scenario],
    { signal: value.signal, env: { ...process.env, EMBER_EVALUATOR_API_KEY: "secret" } });
    const warnings: unknown[] = [];
    const consuming = consumeHermes(handle("native diagnostic text", 2), { ...value, warning: warning => warnings.push(warning) }, "secret", report);
    if (scenario === "length" || scenario === "empty") {
      expect(JSON.parse(stdout)).toHaveProperty("evaluator_output.finishReason", "length");
      expect(stdout).not.toContain("secret");
      expect((await consuming).finalText).toBe(scenario === "empty" ? "" : "partial [redacted]");
      expect(warnings).toEqual([expect.objectContaining({ code: "SOLVER_OUTPUT_LIMIT" })]);
      expect(await readFile(join(value.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"status":"completed"');
    } else {
      expect(JSON.parse(stdout)).not.toHaveProperty("evaluator_output");
      await expect(consuming).rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
    }
  },
);
