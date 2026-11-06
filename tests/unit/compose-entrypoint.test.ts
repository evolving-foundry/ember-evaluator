import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ComposeEntrypoint, composeEntrypointSource } from "../../src/infrastructure/containers/compose-entrypoint.js";
import { DockerComposeProject } from "../../src/infrastructure/containers/compose.js";
import type { JsonValue } from "../../src/core/contracts/task.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "compose-entrypoint-")); roots.push(root); return root;
}

test.each([undefined, null, [], ["/task/bootstrap", "with spaces"]])("preserves entrypoint %j and publishes an idempotent host maintenance latch", async entrypoint => {
  const root = await directory();
  const bootstrap = new ComposeEntrypoint(root, "solve");
  const calls: string[][] = [];
  const command: DockerCommand = async args => { calls.push(args); return { stdout: '["/image/bootstrap"]', stderr: "" }; };
  const main: Record<string, JsonValue> = { image: "locked:image", command: ["node", "idle.mjs"],
    ...(entrypoint === undefined ? {} : { entrypoint }) };
  await bootstrap.configure(main, command, new AbortController().signal);
  const inherited = entrypoint === undefined || entrypoint === null;
  expect(calls.length).toBe(inherited ? 1 : 0);
  expect(JSON.parse(await readFile(join(root, "compose-solve-bootstrap/argv.json"), "utf8")))
    .toEqual([...(inherited ? ["/image/bootstrap"] : entrypoint), "node", "idle.mjs"]);
  expect(main.command).toEqual([]);
  expect(main.volumes).toEqual([expect.objectContaining({ read_only: true })]);
  expect(await readFile(join(root, "compose-solve-bootstrap/entrypoint.mjs"), "utf8")).toBe(composeEntrypointSource);
  await bootstrap.enterMaintenance(new AbortController().signal);
  await bootstrap.enterMaintenance(new AbortController().signal);
  expect(await readFile(join(root, "compose-solve-bootstrap/maintenance"), "utf8")).toBe("");
});

test("Compose normalizes quoted string entrypoints before wrapping them", async () => {
  const root = await directory();
  const command: DockerCommand = async args => ({ stderr: "", stdout: args.includes("config")
    ? JSON.stringify({ services: { main: { entrypoint: ["/task/bootstrap", "with spaces"] } } })
    : args.includes("ps") ? "a".repeat(64) : "" });
  const project = new DockerComposeProject(command, "docker", { image: "fixture", workdir: "/", runtime: [], initialFiles: [],
    services: { main: { image: null, properties: { entrypoint: '/task/bootstrap "with spaces"' } } } },
  { root, agent: root, verifier: root, artifacts: root }, { runId: "run", taskId: "task", attemptId: "attempt" }, "solve");
  await project.create({ image: "fixture", command: ["node", "idle.mjs"] }, {}, {}, new AbortController().signal);
  expect(JSON.parse(await readFile(join(root, "compose-solve-bootstrap/argv.json"), "utf8")))
    .toEqual(["/task/bootstrap", "with spaces", "node", "idle.mjs"]);
});

test.each([false, true])("task command overrides idle and retains isolated network mounts (shell form: %s)", async shellForm => {
  const root = await directory();
  const startup = ["sh", "-c", "echo synthetic service"];
  const command: DockerCommand = async args => ({ stderr: "", stdout: args.includes("config")
    ? JSON.stringify({ services: { main: { command: startup } } })
    : args.includes("ps") ? "a".repeat(64) : args[0] === "image" ? "null" : "" });
  const project = new DockerComposeProject(command, "must-not-run", { image: "fixture", workdir: "/opt", runtime: [], initialFiles: [],
    services: { main: { image: null, properties: { command: shellForm ? 'sh -c "echo synthetic service"' : startup } } } },
  { root, agent: root, verifier: root, artifacts: root }, { runId: "run", taskId: "task", attemptId: "attempt" }, "solve");
  const socket = { type: "volume", source: "synthetic-gateway", target: "/gateway", read_only: true };
  await project.create({ image: "fixture", command: ["node", "idle.mjs"], network_mode: "none", volumes: [socket] }, {}, {}, new AbortController().signal);
  expect(JSON.parse(await readFile(join(root, "compose-solve-bootstrap/argv.json"), "utf8"))).toEqual(startup);
  const document = JSON.parse(await readFile(join(root, "compose-solve.json"), "utf8"));
  expect(document.services.main.network_mode).toBe("none");
  expect(document.services.main.volumes).toContainEqual(socket);
  expect(document.volumes).toEqual({ "synthetic-gateway": { external: true } });
});
