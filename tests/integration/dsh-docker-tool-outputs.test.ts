import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { dshOutputRuntimeFile } from "../../src/runtimes/dsh/runtime.js";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";

const enabled = process.env.EVALUATOR_TEST_DOCKER === "1" && process.platform === "linux" && process.getuid?.() !== 0;

test.skipIf(!enabled).each(["root", "nobody"])("%s tool output is verified live and collected with private permissions", async user => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-dsh-output-transfer-"));
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const signal = AbortSignal.timeout(180_000);
  let session: EnvironmentSession | undefined;
  try {
    session = await new DockerEnvironment().prepare({ image: process.env.EVALUATOR_DOCKER_TEST_IMAGE ?? PINNED_NODE_IMAGE,
      workdir: "/tmp", initialFiles: [], runtime: [], network: "none",
      executionUsers: { solve: user }, installation: { id: "dsh-output-transfer", files: [dshOutputRuntimeFile()], commands: [], probes: [] },
    }, paths, "solve", signal);
    const downloads: string[] = [];
    const download = session.download.bind(session);
    session.download = async (source, target, active) => { downloads.push(source); await download(source, target, active); };
    const text = "private tool output\n".repeat(20_000);
    const code = `import {serializeToolResult} from '/opt/evaluator-agent/dsh-output-hook.mjs';
      const write=e=>process.stdout.write(JSON.stringify(e)+'\\n');
      write({type:'session',sessionId:'fixture',cwd:process.cwd()});
      write({type:'status',phase:'turn_start',turn:1});write({type:'status',phase:'step_start',turn:1,step:1});
      write({type:'tool_call',callId:'large',tool:'bash',input:{}});
      process.stdout.write(serializeToolResult({callId:'large',status:'completed',result:'private tool output\\n'.repeat(20000)},'/logs/agent')+'\\n');
      write({type:'status',phase:'step_end',turn:1,step:1});
      write({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}});write({type:'final',text:'answer'});`;
    const handle = await session.start({ executable: "node", args: ["--input-type=module", "-e", code], cwd: session.workdir, env: {}, input: null }, signal);
    const result = await consumeDsh(handle, { key: { runId: "fixture", taskId: user, attemptId: "one" }, paths, signal, environment: session }, "");
    expect(result.finalText).toBe("answer");
    const records = (await readFile(join(paths.agent, "session.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const output = records.find(event => event.type === "tool_result");
    expect(output).toMatchObject({ truncated: true, storedBytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
    if (user === "nobody") {
      expect(downloads).toEqual([`/logs/${output.resultRef}`]);
      await expect(readFile(join(root, output.resultRef))).rejects.toMatchObject({ code: "EACCES" });
    } else expect(downloads).toEqual([]);
    // Collection still hands logs back only after stopping all container writers.
    await session.quiesce?.(signal);
    const file = join(root, output.resultRef);
    expect(await readFile(file, "utf8")).toBe(text);
    expect((await stat(file)).uid).toBe(process.getuid?.());
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(paths.agent, "tool-outputs"))).mode & 0o777).toBe(0o700);
    expect((await buildFileManifest(root, [output.resultRef])).missing).toEqual([]);
  } finally {
    try { await session?.dispose(AbortSignal.timeout(30_000)); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}, 240_000);
