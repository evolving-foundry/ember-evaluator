import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { RunComponents } from "../../../src/core/contracts/components.js";
import type { LoadedConfig } from "../../../src/config/loaded.js";
import type { EnvironmentSession, PublicTask, SourceLock } from "../../../src/index.js";
import { LocalRunStore } from "../../../src/plugins/stores/local.js";
import { LocalScheduler } from "../../../src/plugins/schedulers/local/scheduler.js";
import { trajectoryLines } from "../results/store-fixture.js";

export const source: SourceLock = { source: "fixture", revision: "immutable", files: [], metadata: {} };
export function harness(root: string, options: { fail?: string | readonly string[]; transfer?: boolean; wait?: boolean; missingSession?: boolean } = {}) {
  const events: string[] = []; const inputs: PublicTask[] = []; const entered = Promise.withResolvers<void>();
  const store = new LocalRunStore(); const commit = store.commit.bind(store);
  store.commit = async (...args) => { events.push("commit"); if (options.fail === "commit") throw new Error("store unavailable"); await commit(...args); };
  const step = (event: string) => {
    events.push(event);
    if (options.fail === event || (Array.isArray(options.fail) && options.fail.includes(event))) throw new Error(`injected ${event}`);
  };
  const components: RunComponents = {
    store, scheduler: new LocalScheduler(2), pluginVersions: { fixture: "1" },
    metrics: [], reporter: { async render() { return "fixture"; } },
    benchmark: {
      async resolveSource() { step("resolve"); return source; },
      async *enumerate() { for (const id of ["a", "b", "c"]) yield { id, recordKey: id }; },
      async prepare(ref) {
        step("prepare");
        return {
          input: { id: ref.id, prompt: "Public question", hidden: "private-solution" }, verification: { expected: "private-solution" },
          solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] },
          verifyEnv: options.transfer ? { workdir: ".", image: null, initialFiles: [], runtime: [] } : null,
          transfer: options.transfer ? { kind: "workspace-archive", workdir: ".", extraPaths: [] } : null,
        };
      },
      async verify(_task, _result, session) {
        step("verify"); if (options.transfer && !session) throw new Error("missing verifier");
        if (!options.transfer && session) throw new Error("unexpected verifier");
        return { score: 1, passed: true, details: {} };
      },
    },
    environment: {
      async prepare(spec, paths, phase) {
        step(`${phase}.environment`);
        if (phase === "solve" && !spec.runtime.some(requirement => requirement.name === "node")) throw new Error("solver runtime lost");
        const workspace = join(root, "workspaces", paths.root.split(/[\\/]/).at(-1)!, phase); await mkdir(workspace, { recursive: true });
        const session: EnvironmentSession = {
          id: `${phase}-id`, workdir: workspace, agentOutputDir: paths.agent, verifierOutputDir: paths.verifier,
          metadata: { phase, fixture: true },
          async start() { throw new Error("unused fixture start"); },
          async upload() { throw new Error("unused fixture upload"); },
          async download() { throw new Error("unused fixture download"); },
          async exportState(spec, target) {
            step("export"); const data = "workspace state"; await writeFile(target, data);
            return { path: target, sha256: createHash("sha256").update(data).digest("hex"), spec };
          },
          async restoreState() { step("restore"); },
          async dispose(signal) {
            if (signal.aborted) throw new Error("cleanup received aborted signal");
            step(`${phase}.cleanup`); await rm(workspace, { recursive: true, force: true });
          },
        };
        return session;
      },
    },
    solver: {
      requirements: () => [{ name: "node", version: "24", platform: "any" }],
      async solve(input, _session, context) {
        inputs.push(input); await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1], context.key));
        step("solve"); entered.resolve();
        if (options.wait) await new Promise<void>((_resolve, reject) => {
          if (context.signal.aborted) reject(context.signal.reason);
          else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
        });
        await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1, 2], context.key));
        if (!options.missingSession) await writeFile(join(context.paths.agent, "session.jsonl"), '{"fixture":true}\n');
        return { finalText: "Answer: 42", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } };
      },
    },
  };
  const config: LoadedConfig = {
    experiment: {
      services: { default: { name: "fixture", provider: "openai", endpoint: "http://fixture.invalid", api: "openai-completions" } },
      benchmark: { name: "fixture", config: {} }, solver: { name: "fixture", config: {}, service: "default" },
      environment: { name: "fixture", config: {} }, metrics: [], reporter: { name: "fixture", config: {} },
      store: { name: "local", config: {} }, scheduler: { name: "local", config: { concurrency: 2 } },
      run: { maxTasks: null, taskIds: null, timeoutSeconds: 10 }, output: { directory: join(root, "runs") },
    },
    persisted: { fixture: true }, auths: { default: { value: "fixture-key", reference: null } },
  };
  return { components, config, events, inputs, entered,
    async dispose() { await store.close(); await rm(join(root, "workspaces"), { recursive: true, force: true }); } };
}
