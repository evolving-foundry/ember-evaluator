import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";

// The SDK boundary is controlled; environment, runtime resolution, subprocesses,
// candidate installation and local runtime invocation are real.
const fixture = vi.hoisted(() => ({ runner: "", version: "0.1.6-alpha.2" }));
vi.mock("../../src/runtimes/agentbundle/sdk.js", () => ({
  AGENT_BUNDLE_CORE_VERSION: "fixture", agentBundleCoreRoot: "unused",
  assertHarnessVersionCompatible: (actual: string, range: string) => { if (actual !== range) throw Error("SOURCE_CHANGED"); },
  verifyBundleCandidate: async (root: string) => ({ digest: root, harness: { name: "dsh", versionRange: fixture.version } }),
}));
vi.mock("../../src/runtimes/agentbundle/runtime-files.js", () => ({
  agentBundleRuntimeFiles: async () => [{ source: fixture.runner, target: "agentbundle/run.mjs" }],
  agentBundleVersionProbe: () => ({ executable: "node", args: ["--eval", "process.exit(0)"] }),
  hashRuntimeSource: async (hash: { update(value: string): void }) => { hash.update("fixture-assets"); },
}));
const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "local-dsh-reuse-"))); roots.push(root);
  const bin = join(root, "bin.js");
  await writeFile(join(root, "package.json"), '{"name":"test-runtime","type":"module"}');
  await writeFile(bin, `import fs from 'node:fs';import path from 'node:path';if(process.argv.includes('--version')) console.log('0.1.6-alpha.2');else if(process.argv.includes('--dump-config'))process.stdout.write(fs.readFileSync(path.join(process.env.DSH_HOME,'settings.yaml'),'utf8'));else if(process.argv.includes('--help'))console.log('fixture help');else throw Error('Unexpected model call');`);
  fixture.runner = join(root, "runner.mjs");
  await writeFile(fixture.runner, `import fs from 'node:fs/promises';import path from 'node:path';const a=process.argv.slice(2);const op=a[1],bundle=a[2];const result={digest:bundle,harness:{name:'dsh',versionRange:'0.1.6-alpha.2',actualVersion:'0.1.6-alpha.2'}};if(op==='install'){const home=a[a.indexOf('--home')+1];await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'settings.yaml'),await fs.readFile(path.join(bundle,'settings.yaml')));Object.assign(result,{home,profile:a[a.indexOf('--profile')+1],reused:false,installationId:'fixture'});}console.log(JSON.stringify(result));`);
  vi.stubEnv("DSH_BIN", bin);
  const makeBundle = async (name: string, prompt: string) => {
    const bundle = join(root, name); await mkdir(bundle);
    await writeFile(join(bundle, "settings.yaml"), `system-prompt:\n  personaSuffix: ${prompt}\nllm-pi-ai:\n  providers:\n    ember-evaluator:\n      timeoutMs: 123\n      retryPolicy: { maxRetries: 0 }\n`);
    return bundle;
  };
  const model = { name: "test", endpoint: "http://example.invalid", provider: null, api: "openai-completions" };
  const environment = new LocalEnvironment(root, join(root, "runtime-cache"));
  const prepare = async (solver: AgentBundleSolver, name: string, execute = false) => {
    const output = join(root, name);
    const paths = { root: output, agent: join(output, "agent"), verifier: join(output, "verifier"), artifacts: join(output, "artifacts") };
    const signal = AbortSignal.timeout(30_000);
    const installation = await solver.runtimeInstallation(signal);
    expect(installation.commands).toEqual([]);
    const session = await environment.prepare({ image: null, workdir: ".", initialFiles: [], runtime: solver.requirements(), installation }, paths, "solve", signal);
    try {
      const context = { key: { runId: "run", taskId: name, attemptId: "one" }, paths, signal };
      const handle = await solver.prepare(session, context);
      try {
        const result = execute ? await handle.solve({ id: name, prompt: "Verify the configured model route" }, context) : null;
        return { record: JSON.parse(await readFile(join(paths.agent, "installation.json"), "utf8")), result };
      } finally { await handle.dispose?.(signal); }
    } finally { await session.dispose(new AbortController().signal); }
  };
  return { root, bin, makeBundle, model, prepare };
}

test("local DSH is reused with no install commands, preserving shared candidate homes", async () => {
 const f=await setup(); const bundle=await f.makeBundle("a","candidate-a");
 const solver=new AgentBundleSolver(bundle,f.model,{value:"",reference:null},undefined,{environmentName:"local"});
 const first=await f.prepare(solver,"task-a");
 const repeated=await f.prepare(solver,"task-b");
 expect(first.record.home).toBe(repeated.record.home);
 const launcher=await readFile(join(first.record.home,"dsh-launcher.js"),"utf8");
 expect(launcher).toContain(JSON.stringify(f.bin));
 expect(first.record.harness.actualVersion).toBe("0.1.6-alpha.2");
},60000);

test("DSH receives the model route through an explicit patch without replacing candidate settings", async () => {
  const f = await setup();
  await writeFile(f.bin, `import fs from 'node:fs';import path from 'node:path';import {parse} from ${JSON.stringify(import.meta.resolve("yaml"))};
if(process.argv.includes('--version'))console.log('0.1.6-alpha.2');
else {
  for await(const chunk of process.stdin){}
  const patches=process.argv.flatMap((arg,i)=>arg==='--patch'?parse(fs.readFileSync(process.argv[i+1],'utf8')):[]);
  const model=patches.find(entry=>entry.id==='agent-default-model')?.config;
  const provider=patches.find(entry=>entry.id==='llm-pi-ai')?.config.providers[model?.provider];
  if(model?.provider!=='ember-evaluator'||model.model!=='test'||provider?.baseURL!=='http://example.invalid'||process.env[provider?.apiKeyEnv]!=='route-secret')throw Error('Configured model route was not applied');
  if(!fs.readFileSync(path.join(process.env.DSH_HOME,'settings.yaml'),'utf8').includes('candidate-a'))throw Error('Candidate settings were replaced');
  const emit=event=>console.log(JSON.stringify(event));
  emit({type:'session',sessionId:'route',cwd:process.cwd()});
  emit({type:'status',phase:'turn_start',turn:1});
  emit({type:'status',phase:'step_start',turn:1,step:1});
  emit({type:'status',phase:'step_end',turn:1,step:1});
  emit({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}});
  emit({type:'final',text:'configured route applied'});
}
`);
  const bundle = await f.makeBundle("model-route", "candidate-a");
  const solver = new AgentBundleSolver(bundle, f.model, { value: "route-secret", reference: null }, undefined, { environmentName: "local" });
  const result = await f.prepare(solver, "model-route", true);
  expect(result.result?.finalText).toBe("configured route applied");
  expect(await readFile(join(result.record.home, "model.patch.yaml"), "utf8")).not.toContain("route-secret");
}, 60000);

test("Docker keeps its install recipe and ignores host DSH_BIN", async () => {
 const f=await setup(); const bundle=await f.makeBundle("a","a");
 fixture.version = "0.2.2-rc.1";
 vi.stubEnv("DSH_BIN",join(f.root,"missing.js"));
 const solver=new AgentBundleSolver(bundle,f.model,{value:"",reference:null},undefined,{environmentName:"docker"});
 try {
  const recipe=await solver.runtimeInstallation(AbortSignal.timeout(15000));
  expect(recipe.commands.some(command=>command.executable==="npm"&&command.args[0]==="ci")).toBe(true);
 } finally {
  fixture.version = "0.1.6-alpha.2";
  await solver.dispose();
 }
});
