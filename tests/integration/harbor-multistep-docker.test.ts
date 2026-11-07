import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { HarborBenchmark, parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/index.js";
import { runTask } from "../../src/core/execution/run-task.js";
import { onDemand } from "../../src/core/preparation/task-preparation.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { harness } from "../fixtures/engine/fakes.js";
import { storeRun, trajectoryLines } from "../fixtures/results/store-fixture.js";

test.skipIf(process.env.EVALUATOR_HARBOR_DOCKER_TESTS !== "1")("native shared steps retain state, overlay tests, restore allowlists and remove private materials", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-multistep-docker-"));
  const upstream = createServer((_req, response) => response.end("model-route"));
  await new Promise<void>(resolve => upstream.listen(0, "0.0.0.0", resolve));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const endpoint = `http://host.docker.internal:${address.port}/v1`;
  const value = harness(root);
  const signal = () => AbortSignal.timeout(240_000);
  try {
    await writeFixture(join(root, "dataset/tasks/example"), {
      "task.toml": `schema_version="1.3"\n[[steps]]\nname="first"\nmin_reward=0.6\n[[steps]]\nname="second"\n[environment]\ndocker_image="${PINNED_NODE_IMAGE}"\nworkdir="/workspace"\n[agent]\nnetwork_mode="allowlist"\nallowed_hosts=["host.docker.internal"]\n[verifier]\nnetwork_mode="no-network"\n`,
      "tests/shared-secret": "private-answer",
      "steps/first/instruction.md": "first",
      "steps/second/instruction.md": "second",
      "steps/second/workdir/payload.txt": "delayed-input",
      "steps/first/tests/test.sh": 'set -eu\ntest "$(id -un)" = root\ntest "$(cat /workspace/state.txt)" = first\ntest "$(cat /tests/shared-secret)" = private-answer\nprintf 0.8 > /logs/verifier/reward.txt\n',
      "steps/second/tests/test.sh": 'set -eu\ntest "$(id -un)" = root\ntest "$(cat /workspace/state.txt)" = second\ntest "$(cat /tests/shared-secret)" = private-answer\nprintf 1 > /logs/verifier/reward.txt\n',
    });
    value.components.benchmark = new HarborBenchmark(parseHarborConfig({ source: { kind: "local", path: join(root, "dataset") },
      defaults: { agentUser: "dev", verifierUser: "root", scoreAfterSolveFailure: true } }));
    value.components.environment = new DockerEnvironment({ modelEndpoint: endpoint });
    value.components.solver.solve = async (input, session, context) => {
      const code = `const f=require('node:fs'); if(process.getuid()===0)throw Error('root solver'); if(f.existsSync('/tests/shared-secret')||f.existsSync('/logs/verifier/reward.txt'))throw Error('private material leaked');
        if(${input.prompt === "first"}){if(f.existsSync('/workspace/payload.txt'))throw Error('future input leaked')}else{if(f.readFileSync('/workspace/state.txt','utf8')!=='first')throw Error('state lost');if(f.readFileSync('/workspace/payload.txt','utf8')!=='delayed-input')throw Error('missing step workdir')}
        fetch(${JSON.stringify(session.modelEndpoint!.baseUrl + "/chat/completions")}).then(async r=>{if(await r.text()!=='model-route')throw Error('network not restored');f.writeFileSync('/workspace/state.txt',${JSON.stringify(input.prompt)});}).catch(e=>{console.error(e);process.exit(1)});`;
      const exit = await readProcess(await session.start({ executable: "node", args: ["-e", code], cwd: session.workdir, env: {}, input: null }, context.signal), context.signal);
      if (exit.code !== 0) throw new Error(exit.stderr);
      await writeFile(join(context.paths.agent, "trajectory.jsonl"), trajectoryLines([1, 2], context.key));
      await writeFile(join(context.paths.agent, "session.jsonl"), '{"fixture":true}\n');
      return { finalText: input.prompt, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    };
    const source = await value.components.benchmark.resolveSource(null, signal());
    const refs = []; for await (const ref of value.components.benchmark.enumerate(source, signal())) refs.push(ref);
    const ref = refs[0]!;
    await value.components.store.create(value.config.experiment.output.directory, { ...storeRun, source, taskIds: [ref.id] }, {});
    const record = await runTask(onDemand({ runId: storeRun.runId, taskId: ref.id, attemptId: "first", ref, configFingerprint: storeRun.configFingerprint }), value.components, source, signal(), { timeoutSeconds: 240 });
    expect(record.errors).toEqual([]);
    expect(record).toMatchObject({ executionStatus: "completed", verdict: { score: 0.9 }, solve: { usage: { totalTokens: 4 } } });
    expect(record.steps?.map(step => step.verdict?.score)).toEqual([0.8, 1]);
    const results = await value.components.store.listAttempts();
    expect(results).toHaveLength(1);
  } finally {
    await value.dispose();
    await new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()); });
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
