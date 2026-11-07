import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { writeFixture } from "../fixtures/dataset-tasks.js";
import { readComposeServices } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/readers/compose.js";
import { loadGenericHarborTask } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/task.js";
import { parseHarborConfig } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config.js";
import { HarborShellVerifier } from "../../src/plugins/verifiers/shell.js";
import { DockerComposeProject, composeEnvironment } from "../../src/infrastructure/containers/compose.js";
import { validateTransferSpec } from "../../src/infrastructure/filesystem/workspace-transfer.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(compose: string) {
  const root = await mkdtemp(join(tmpdir(), "harbor-compose-")); roots.push(root);
  await writeFixture(root, {
    "environment/docker-compose.yaml": compose,
    "environment/Dockerfile.agent": "FROM node:24\nWORKDIR /workspace\n",
    "environment/api/Dockerfile": "FROM node:24\n",
    "instruction.md": "Use the API.\n", "tests/test.sh": "true\n",
    "task.toml": 'artifacts = [{source="/shared/result.json",service="api"}]\n[environment]\ncpus=2\n[verifier]\nenvironment_mode="separate"\n[[verifier.collect]]\nservice="api"\ncommand="true"\n',
  });
  return root;
}
const compose = `services:
  main:
    build: {context: ., dockerfile: Dockerfile.agent}
    network_mode: service:api
    depends_on: {api: {condition: service_healthy}}
  api:
    build: {context: ./api}
    healthcheck: {test: [CMD, node, --version], interval: 1s, retries: 10}
`;
test("Harbor resolves main Dockerfile, sidecar health dependencies, collect and artifacts", async () => {
  const root = await fixture(compose);
  const task = await loadGenericHarborTask(root, root, "example", parseHarborConfig({}), new HarborShellVerifier(), new AbortController().signal);
  expect(task.solveEnv.build?.dockerfile).toBe("Dockerfile.agent");
  expect(task.solveEnv.workdir).toBe("/workspace");
  expect(task.solveEnv.services?.api?.build?.context).toBe(join(root, "environment/api"));
  expect(task.collect?.[0]?.service).toBe("api");
  expect(task.collect?.[0]?.executable).toBe("sh");
  expect(task.transfer).toMatchObject({ services: { "/shared/result.json": "api" } });
  expect(task.verifyEnv?.services).toEqual(task.solveEnv.services);
});
test("published Compose images precede source builds while preserving service dependencies", async () => {
  const root = await fixture(`services:
  main:
    image: agent@sha256:${"a".repeat(64)}
    build: ./unshipped-main
    depends_on: {api: {condition: service_healthy}}
  api:
    image: api@sha256:${"b".repeat(64)}
    build: ./unshipped-api
    healthcheck: {test: [CMD, node, --version]}
`);
  const task = await loadGenericHarborTask(root, root, "example", parseHarborConfig({}), new HarborShellVerifier(), new AbortController().signal);
  expect(task.solveEnv.image).toBe("agent@sha256:" + "a".repeat(64));
  expect(task.solveEnv.build).toBeUndefined();
  expect(task.solveEnv.services?.api?.image).toBe("api@sha256:" + "b".repeat(64));
  expect(task.solveEnv.services?.api?.build).toBeUndefined();
  expect(task.solveEnv.services?.main?.properties.depends_on).toEqual({ api: { condition: "service_healthy" } });
});
test.each([
  "privileged: true", "network_mode: host", "volumes: [/var/run/docker.sock:/var/run/docker.sock]",
  "container_name: shared", "ports: ['22:22']", "cap_add: [SYS_ADMIN]",
  "build: {context: ../}", "build: {context: ., dockerfile: ../../private}",
])("rejects unsafe or unsupported service declaration %s", async property => {
  const root = await fixture(`services:\n  main:\n    ${property}\n`);
  await expect(readComposeServices(join(root, "environment"), "public")).rejects.toThrow();
});
test("rejects unknown service references and artifact roots before copying", async () => {
  const root = await fixture("services:\n  main:\n    depends_on: [missing]\n");
  await expect(readComposeServices(join(root, "environment"), "public")).rejects.toThrow("dependency");
  expect(() => validateTransferSpec({ kind: "artifacts", workdir: "/app", paths: ["/shared/file"], services: { "/tests": "api" } }, "/app")).toThrow("service mapping");
  expect(() => composeEnvironment(["INHERIT_HOST_SECRET"])).toThrow("explicit values");
});
test.each(["", 'docker_image="agent:locked"\n'])("main extra_hosts overlay remains a single-container environment with image declaration %s", async image => {
  const root = await fixture("services:\n  main:\n    extra_hosts: [host.docker.internal:host-gateway]\n");
  await writeFile(join(root, "environment/Dockerfile"), "FROM fixture\nWORKDIR /workspace\n");
  await writeFile(join(root, "task.toml"), '[environment]\n' + image + 'allow_internet=false\n');
  const task = await loadGenericHarborTask(root, root, "legacy", parseHarborConfig({}), new HarborShellVerifier(), new AbortController().signal);
  expect(task.solveEnv.services).toBeUndefined();
  expect(task.solveEnv.extraHosts).toEqual(["host.docker.internal:host-gateway"]);
  expect(task.solveEnv.network).toBe("model-api");
});
test("isolates attempts and preserves shared networks, conditions and labels", async () => {
  const root = await fixture(compose);
  const calls: string[][] = [];
  const command: DockerCommand = async args => { calls.push(args); return { stdout: args.includes("ps") ? "a".repeat(64) : args[0] === "image" ? "null" : "", stderr: "" }; };
  const spec = { image: "fixture", workdir: "/workspace", initialFiles: [], runtime: [], services: await readComposeServices(join(root, "environment"), "public") };
  if (!spec.services) throw new Error("Missing services");
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const first = new DockerComposeProject(command, "docker", { ...spec, services: spec.services }, paths, { runId: "run", taskId: "task", attemptId: "one" }, "solve");
  const second = new DockerComposeProject(command, "docker", { ...spec, services: spec.services }, paths, { runId: "run", taskId: "task", attemptId: "two" }, "solve");
  expect(first.name).not.toBe(second.name);
  await first.create({ image: "main:locked", platform: "linux/arm64", command: ["node", "idle.mjs"], environment: { A: "main" } }, { api: "api:locked" }, { "ember.attempt": "one" }, new AbortController().signal);
  const document = JSON.parse(await readFile(join(root, "compose-solve.json"), "utf8"));
  expect(document.services.main.network_mode).toBe("service:api");
  expect(document.services.main.depends_on.api.condition).toBe("service_healthy");
  expect(document.services.api.platform).toBe("linux/arm64");
  expect(document.services.api.build).toBeUndefined();
  expect(calls.some(args => args.includes("--wait") && args.includes("--no-build"))).toBe(true);
  await first.dispose(new AbortController().signal);
  expect(calls.at(-1)).toContain("down");
  expect(calls.at(-1)).toContain("--volumes");
});
test("failed project startup cleans its own resources", async () => {
  const root = await fixture(compose);
  const calls: string[][] = [];
  const command = vi.fn<DockerCommand>(async args => { calls.push(args); if (args.includes("up")) throw new Error("healthcheck failed"); return { stdout: args[0] === "image" ? "null" : "", stderr: "" }; });
  const project = new DockerComposeProject(command, "docker", { image: "main", workdir: "/app", initialFiles: [], runtime: [] },
    { root, agent: root, verifier: root, artifacts: root }, { runId: "run", taskId: "task", attemptId: "failure" }, "solve");
  await expect(project.create({ image: "main", command: ["node", "idle.mjs"] }, {}, {}, new AbortController().signal)).rejects.toThrow("could not start");
  expect(calls.at(-1)).toContain("down");
});
