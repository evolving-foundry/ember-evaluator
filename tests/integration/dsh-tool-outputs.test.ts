import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { dshOutputRuntimeFile } from "../../src/runtimes/dsh/runtime.js";
import { localDshLauncher } from "../../src/runtimes/dsh/local-runtime.js";
import { startLocalProcess } from "../../src/infrastructure/process/local.js";
import { buildFileManifest, verifyFileManifest } from "../../src/core/artifacts/artifacts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(checkout = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "DSH output evidence ")));
  roots.push(root);
  const paths = { root: join(root, "attempt"), agent: join(root, "attempt", "agent"),
    verifier: join(root, "attempt", "verifier"), artifacts: join(root, "attempt", "artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  const module = checkout ? join(root, "packages", "bundle", "headless", "src", "json-stream.ts")
    : join(root, "node_modules", "@deepseek-ai", "dsh-headless", "lib", "json-stream-fixture.js");
  await mkdir(join(root, "node_modules", "@deepseek-ai", "dsh-headless", "lib"), { recursive: true });
  await writeFile(join(root, "node_modules", "@deepseek-ai", "dsh-headless", "package.json"), '{"type":"module"}');
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await mkdir(dirname(module), { recursive: true });
  await copyFile(fileURLToPath(new URL("../fixtures/dsh-json-exporter.mjs", import.meta.url)), module);
  if (checkout) {
    const source = await readFile(module, "utf8");
    await writeFile(module, source.replace("function boundJsonLine(event,", "function boundJsonLine(event: Record<string, unknown>,"));
  }
  const entry = join(root, "dsh.mjs");
  await writeFile(entry, `import {boundJsonLine} from ${JSON.stringify(pathToFileURL(module).href)};
if(process.env.NODE_OPTIONS?.includes('output-hook.mjs'))throw Error('Output hook leaked to tool child environment');
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const inputs=JSON.parse(Buffer.concat(chunks));
const write=event=>process.stdout.write(JSON.stringify(event)+'\\n');
write({type:'session',sessionId:'test',cwd:process.cwd()});
write({type:'status',phase:'turn_start',turn:1});write({type:'status',phase:'step_start',turn:1,step:1});
for(const event of inputs)write({type:'tool_call',callId:event.callId,tool:'bash',input:{}});
for(const event of inputs){const before=JSON.stringify(event);Object.freeze(event);process.stdout.write(boundJsonLine(event)+'\\n');if(JSON.stringify(event)!==before)throw Error('Model-facing object changed');}
write({type:'status',phase:'step_end',turn:1,step:1});write({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}});
write({type:'final',text:'answer'});
`);
  return { root, paths, entry };
}

test.each(["direct", "local-launcher", "path-shim", "checkout-ts"])("%s retains large/escaped output, tool identity and failure state without changing model data", async mode => {
  const { root, paths, entry } = await fixture(mode === "checkout-ts");
  const hook = dshOutputRuntimeFile().source;
  let args = ["--import", pathToFileURL(hook).href, entry];
  if (mode !== "direct" && mode !== "checkout-ts") {
    let executable = process.execPath;
    let selectedArgs = [entry];
    if (mode === "path-shim") {
      executable = join(root, process.platform === "win32" ? "dsh.cmd" : "dsh");
      await writeFile(executable, process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath}' '${entry}' "$@"\n`, { mode: 0o755 });
      selectedArgs = [];
    }
    const launcher = await localDshLauncher({ executable, args: selectedArgs, extraEnv: {} }, root, hook);
    args = [launcher];
  }
  const secret = "model-secret-to-redact";
  const text = `PASS start\n${"a".repeat(300 * 1024)}\n${secret}\n${encodeURIComponent(secret)}\nTest Suites: 42 passed`;
  const inputs = [
    { type: "tool_result", callId: "../../unsafe-call", status: "completed", result: text },
    { type: "tool_result", callId: "second", status: "error", result: "\u0000".repeat(300 * 1024) + "错误结束" },
    { type: "tool_result", callId: "small", status: "completed", result: "ok" },
  ];
  const signal = AbortSignal.timeout(20_000);
  const handle = await startLocalProcess({ executable: process.execPath, args, cwd: root,
    env: { EVALUATOR_DSH_OUTPUT_DIR: paths.agent, EMBER_EVALUATOR_API_KEY: secret, NODE_OPTIONS: "--stack-trace-limit=17" },
    input: Buffer.from(JSON.stringify(inputs)) }, signal);
  const result = await consumeDsh(handle, { key: { runId: "run", taskId: mode, attemptId: "one" }, paths, signal }, secret);
  expect(result.finalText).toBe("answer");
  const session = await readFile(join(paths.agent, "session.jsonl"), "utf8");
  expect(session).not.toContain(secret);
  const records = session.trim().split("\n").map(line => JSON.parse(line));
  const outputs = records.filter(record => record.type === "tool_result");
  expect(outputs).toHaveLength(3);
  expect(outputs[0]).toMatchObject({ callId: "../../unsafe-call", status: "completed", truncated: true, originalBytes: Buffer.byteLength(text) });
  expect(outputs[0].result).toContain("PASS start");
  expect(outputs[0].result).toContain("Test Suites: 42 passed");
  expect(outputs[1]).toMatchObject({ callId: "second", status: "error", truncated: true });
  expect(outputs[1].result).toContain("错误结束");
  expect(outputs[2]).toEqual(inputs[2]);
  const manifest = await buildFileManifest(paths.root, []);
  const files = manifest.files.filter(file => file.path.startsWith("agent/tool-outputs/"));
  expect(files).toHaveLength(2);
  for (const event of outputs.slice(0, 2)) {
    expect(Buffer.byteLength(JSON.stringify(event)) + 1).toBeLessThanOrEqual(32 * 1024);
    const file = await readFile(join(paths.root, event.resultRef));
    expect(file).toHaveLength(event.storedBytes);
    expect(createHash("sha256").update(file).digest("hex")).toBe(event.sha256);
    expect(files.find(item => item.path === event.resultRef)?.sha256).toBe(event.sha256);
  }
  const full = await readFile(join(paths.root, outputs[0].resultRef), "utf8");
  expect(full).toBe(text.replaceAll(secret, "[redacted]"));
  expect(await readFile(join(paths.root, outputs[1].resultRef), "utf8")).toBe(inputs[1]?.result);
  await verifyFileManifest(paths.root, manifest);
}, 30_000);

test("a blocked output directory fails the process and never publishes a fabricated successful result", async () => {
  const { root, paths, entry } = await fixture();
  await writeFile(join(paths.agent, "tool-outputs"), "blocked");
  const signal = AbortSignal.timeout(15_000);
  const handle = await startLocalProcess({ executable: process.execPath,
    args: ["--import", pathToFileURL(dshOutputRuntimeFile().source).href, entry], cwd: root,
    env: { EVALUATOR_DSH_OUTPUT_DIR: paths.agent },
    input: Buffer.from(JSON.stringify([{ type: "tool_result", callId: "call", status: "completed", result: "x".repeat(300 * 1024) }])) }, signal);
  await expect(consumeDsh(handle, { key: { runId: "run", taskId: "blocked", attemptId: "one" }, paths, signal }, ""))
    .rejects.toMatchObject({ code: "SOLVER_PROCESS_CRASHED" });
  expect(await readFile(join(paths.agent, "session.jsonl"), "utf8")).not.toContain('"type":"tool_result"');
  expect(await readFile(join(paths.agent, "stderr.log"), "utf8")).toContain("EEXIST");
});
