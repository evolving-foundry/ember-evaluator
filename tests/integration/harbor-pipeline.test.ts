import "../fixtures/network-fetch.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, Header } from "tar";
import { afterEach, expect, test, vi } from "vitest";
import { HarborBenchmark, parseHarborConfig, scoreHarborEvidence } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/index.js";
import { HarborShellVerifier, parseRewardEvidence } from "../../src/plugins/verifiers/shell.js";
import { loadGenericHarborTask } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/task.js";
import { materializeDirectory } from "../../src/infrastructure/datasets/sources/directory.js";
import { validatePortableSelection } from "../../src/infrastructure/ray/protocol.js";
import { harborConfigTransport } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/config-transport.js";
import type { EnvironmentSession, ProcessHandle } from "../../src/core/contracts/environment.js";
import { validateTransferSpec } from "../../src/infrastructure/filesystem/workspace-transfer.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";

const roots: string[] = [];

test("Harbor accepts upstream schema markers, mixed artifacts and main exclusions", async () => {
  const root = await fixture('schema_version = "2.0"\nartifacts = ["/app/result.json", { source = "/workspace/app/", exclude = ["node_modules", "*.pyc"] }]\n[environment]\ndocker_image = "fixture:locked"\nworkdir = "/workspace"\n[agent]\ntimeout_sec = 28800\n[verifier]\nenvironment_mode = "separate"\n');
  const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal());
  expect(task.transfer).toMatchObject({ paths: ["/app/result.json", "/workspace/app"],
    optionalPaths: ["/app/result.json", "/workspace/app"],
    excludes: { "/workspace/app": ["node_modules", "*.pyc"] } });
  expect(task.phaseTimeoutSeconds?.solve).toBe(28800);
  validateTransferSpec(task.transfer!, "/workspace");
});
const signal = () => new AbortController().signal;
async function fixture(toml = "") {
  const root = await mkdtemp(join(tmpdir(), "generic-harbor-")); roots.push(root);
  await writeFixture(root, {
    "tasks/example/task.toml": toml || 'schema_version = "1.3"\n[task]\nname = "bench/example"\n[environment]\ncpus = 2\nmemory_mb = 1024\n[agent]\ntimeout_sec = 120\n[verifier]\ntimeout_sec = 30\n',
    "tasks/example/instruction.md": "Create a deliverable.\n",
    "tasks/example/environment/Dockerfile": "FROM fixture:locked\nWORKDIR /workspace\n",
    "tasks/example/tests/test.sh": "private verification\n",
    "shared/verifier/plugin.py": "# private dataset plugin\n",
    "dataset.toml": "# dataset contract\n",
  });
  return root;
}

test("explicit integration artifact defaults collect only their declared paths without changing task files", async () => {
  const root = await fixture();
  const taskFile = join(root, "tasks/example/task.toml");
  const before = await readFile(taskFile, "utf8");
  const config = parseHarborConfig({ defaults: { artifactPaths: ["/workspace/output"] } });
  const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", config, new HarborShellVerifier(), signal());
  expect(task.artifactCollection).toMatchObject({ kind: "artifacts", paths: ["/workspace/output"] });
  validateTransferSpec(task.artifactCollection!, "/workspace");
  expect(await readFile(taskFile, "utf8")).toBe(before);
  await writeFile(taskFile, 'artifacts = ["/workspace/custom.txt"]\n' + before);
  const declared = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", config, new HarborShellVerifier(), signal());
  expect(declared.artifactCollection?.paths).toEqual(["/workspace/custom.txt"]);
});

test.each([false, true])("omitted or empty artifacts do not create a collection or transfer: separate=%s", async separate => {
  for (const declaration of ["", "artifacts = []\n"]) {
    const root = await fixture(declaration + '[environment]\ndocker_image="fixture:locked"\n[verifier]\n' + (separate ? 'environment_mode="separate"\n' : ""));
    const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal());
    expect(task.transfer).toBeNull();
    expect(task.artifactCollection).toBeUndefined();
    expect(task.verifyEnv === null).toBe(!separate);
  }
});

test("explicit empty artifacts disable integration defaults and extra task paths", async () => {
  const root = await fixture('artifacts = []\n[environment]\ndocker_image="fixture:locked"\n');
  const config = parseHarborConfig({ defaults: { artifactPaths: ["/workspace/output"] },
    taskProfiles: { example: { workdir: "/app", extraPaths: ["/deliverables"] } } });
  const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", config, new HarborShellVerifier(), signal());
  expect(task.artifactCollection).toBeUndefined();
  expect(task.transfer).toBeNull();
});

test.each([
  { artifactPaths: ["relative"] }, { artifactPaths: ["/workspace/../tests"] },
  { artifactPaths: ["/"] }, { artifactPaths: ["/workspace", "/workspace"] },
])("Harbor rejects unsafe or duplicate default artifact paths: $artifactPaths", ({ artifactPaths }) => {
  expect(() => parseHarborConfig({ defaults: { artifactPaths } })).toThrow(/artifactPaths/);
});
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("one Harbor configuration locks, enumerates and prepares a new local dataset", async () => {
  const root = await fixture();
  const benchmark = new HarborBenchmark(parseHarborConfig({ dataset: "example@1", source: { kind: "local", path: root }, tasks: { expectedCount: 1 } }));
  const source = await benchmark.resolveSource(null, signal());
  expect(JSON.stringify(source)).not.toContain(root);
  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal())) refs.push(ref);
  expect(refs).toEqual([{ id: "bench/example", recordKey: "tasks/example" }]);
  const task = await benchmark.prepare(refs[0]!, source, signal());
  expect(task).toMatchObject({ verificationMode: "shared", verifyEnv: null, transfer: null,
    solveEnv: { workdir: "/workspace", resources: { cpus: 2, memory: "1024m" } }, phaseTimeoutSeconds: { solve: 120, verify: 30 } });
  expect(JSON.stringify(task.input)).not.toContain("private");
  expect(task.solveEnv.build?.context).toBe(join(root, "tasks/example/environment"));
  await writeFile(join(root, "shared/verifier/plugin.py"), "# changed\n");
  await expect(benchmark.prepare(refs[0]!, source, signal())).rejects.toThrow(/source changed/i);
  await expect(benchmark.resolveSource(source, signal())).rejects.toThrow(/differs/);
});

test("selection records excluded tasks and rejects a wrong expected count", async () => {
  const root = await fixture();
  await writeFixture(root, { "tasks/multistep/task.toml": 'schema_version = "1.3"\nsteps = []\n' });
  const config = { source: { kind: "local", path: root }, tasks: { requireTestScript: true, expectedCount: 1 } };
  const benchmark = new HarborBenchmark(parseHarborConfig(config));
  const source = await benchmark.resolveSource(null, signal());
  expect(source.metadata).toMatchObject({ excluded: [{ path: "multistep", reason: expect.stringContaining("requireTestScript") }] });
  await expect(new HarborBenchmark(parseHarborConfig({ ...config, tasks: { expectedCount: 3 } })).resolveSource(null, signal())).rejects.toThrow(/Expected 3/);
});

test.each(["tasks/helper.py", "tasks/multistep/README.md", "tasks/example/instruction.md"])("prepares mixed task directories and still detects changes to %s", async changed => {
  const root = await fixture();
  await writeFixture(root, {
    "tasks/other/task.toml": '[task]\nname = "bench/other"\n',
    "tasks/other/instruction.md": "Another task.\n",
    "tasks/other/tests/test.sh": "private verification\n",
    "tasks/multistep/task.toml": 'schema_version = "1.3"\nsteps = []\n',
    "tasks/multistep/README.md": "Excluded task asset.\n",
    "tasks/helper.py": "# shared verifier helper\n",
  });
  const benchmark = new HarborBenchmark(parseHarborConfig({ source: { kind: "local", path: root }, tasks: { requireTestScript: true, expectedCount: 2 } }));
  const source = await benchmark.resolveSource(null, signal());
  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal())) refs.push(ref);
  expect(refs).toHaveLength(2);
  await expect(benchmark.prepare(refs[0]!, source, signal())).resolves.toMatchObject({ input: { id: "bench/example" } });
  await writeFile(join(root, changed), "changed\n");
  await expect(benchmark.prepare(refs[0]!, source, signal())).rejects.toThrow(/source changed/i);
});

test("separate verification uses a private build context and declared artifact collection", async () => {
  const root = await fixture('schema_version = "1.3"\nartifacts = ["/logs/artifacts/model.patch"]\n[environment]\ndocker_image = "fixture:locked"\nworkdir = "/app"\n[agent]\nnetwork_mode = "no-network"\n[verifier]\nenvironment_mode = "separate"\nnetwork_mode = "no-network"\n[[verifier.collect]]\ncommand = "git diff --binary BASE HEAD > /logs/artifacts/model.patch"\ntimeout_sec = 20\n[verifier.environment]\nworkdir = "/grading"\nbuild_timeout_sec = 1800\n');
  await writeFixture(root, { "tasks/example/tests/Dockerfile": "FROM fixture:locked\nCOPY . /tests\n" });
  const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal());
  expect(task).toMatchObject({ verificationMode: "separate", solveEnv: { network: "model-api", workdir: "/app", image: "fixture:locked" },
    verifyEnv: { workdir: "/grading", network: "none", build: { visibility: "verifier", context: join(root, "tasks/example/tests") } },
    transfer: { kind: "artifacts", paths: ["/logs/artifacts/model.patch"], optionalPaths: ["/logs/artifacts/model.patch"] }, collect: [{ timeoutSeconds: 20 }], preparationTimeoutSeconds: { solve: 600, verify: 1800 }, phaseTimeoutSeconds: {} });
});

test.each([
  ['gpus = 1', /requires GPU.*hardware=npu.*mismatch/],
  ['os = "windows"', /Only Linux/],
  ['network_mode = "private"', /Unsupported network_mode/],
] as const)("rejects unsupported capabilities: %s", async (capability, message) => {
  const root = await fixture(`schema_version = "1.3"\n[environment]\n${capability}\n`);
  await expect(loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal())).rejects.toThrow(message);
});
test("rejects malformed MCP declarations instead of silently ignoring them", async () => {
  const root = await fixture('schema_version = "1.3"\n[environment]\nmcp_servers = ["server"]\n');
  await expect(loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal())).rejects.toMatchObject({ code: "TASK_DATA_INVALID" });
});

test("archive source validates pinned bytes, extracts once safely and detects cache changes", async () => {
  const root = await fixture(); const archive = join(root, "dataset.tar.gz");
  await create({ cwd: root, file: archive, gzip: true }, ["tasks", "shared", "dataset.toml"]);
  const bytes = await readFile(archive);
  const server = createServer((_request, response) => response.end(bytes));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  const source = { kind: "archive" as const, url: `http://127.0.0.1:${address.port}/dataset.tar.gz`, sha256: createHash("sha256").update(bytes).digest("hex"), root: "." };
  try {
    const first = await materializeDirectory(source, join(root, "cache"), signal());
    expect((await materializeDirectory(source, join(root, "cache"), signal())).revision).toBe(first.revision);
    await writeFile(join(first.directory, "tasks/example/instruction.md"), "changed");
    await expect(materializeDirectory(source, join(root, "cache"), signal())).rejects.toThrow(/differs/);
    await expect(materializeDirectory({ ...source, sha256: "0".repeat(64) }, join(root, "cache"), signal())).rejects.toThrow(/digest|hash|sha256|checksum/i);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("multi-dimensional rewards preserve raw values and explicit error sentinels", () => {
  const evidence = { rewards: parseRewardEvidence('{"reward":0.5,"f2p":0.75,"p2p":1}', "json"), details: { exitCode: 1 } };
  expect(scoreHarborEvidence(evidence, parseHarborConfig({ scoring: { passThreshold: 0.5 } }).scoring)).toMatchObject({ score: 0.5, passed: true, details: { rewards: { f2p: 0.75, p2p: 1 } } });
  expect(() => scoreHarborEvidence({ ...evidence, rewards: { reward: -1 } }, parseHarborConfig({ scoring: { errorValues: [-1] } }).scoring)).toThrow(/sentinel/);
  for (const text of ["", "NaN", "1 2"]) expect(() => parseRewardEvidence(text, "txt")).toThrow();
  for (const text of ['{"reward":null}', '{"reward":"1"}', '{}']) expect(() => parseRewardEvidence(text, "json")).toThrow();
});

test("a nonzero verifier exit still accepts valid reward evidence", async () => {
  const root = await fixture(); const calls: string[] = [];
  const handle = (stdout: string, code: number): ProcessHandle => ({
    stdout: (async function* () { yield Buffer.from(stdout); })(), stderr: (async function* () {})(),
    done: Promise.resolve({ code, signal: null }), async stop() {},
  });
  const session: EnvironmentSession = { id: "verify", workdir: "/workspace", agentOutputDir: root, verifierOutputDir: root, metadata: {},
    async upload(_source, target) { calls.push(target); }, async start(command) { calls.push(command.executable); return calls.length === 2 ? handle("", 1) : handle('json\n{"reward":0,"f2p":0.25}', 0); },
    async download() {}, async exportState() { throw new Error("unused"); }, async restoreState() {}, async dispose() {},
  };
  const verifier = new HarborShellVerifier();
  const descriptor = await verifier.prepare({ id: "x", taskDir: join(root, "tasks/example"), datasetDir: root, workdir: "/workspace", timeoutSeconds: 30 }, signal());
  expect(await verifier.verify({ descriptor, env: {} }, session, signal())).toMatchObject({ rewards: { reward: 0, f2p: 0.25 }, details: { exitCode: 1 } });
});

test("Ray transports verifier selection while rejecting host-only sources and inline secrets", () => {
  expect(validatePortableSelection({ name: "harbor-python", service: "judge", config: { requireService: true } }, "verifier")).toMatchObject({ service: "judge" });
  expect(() => validatePortableSelection({ name: "harbor", config: { source: { kind: "local", path: "relative" } } }, "benchmark", () => harborConfigTransport)).toThrow(/cannot distribute/);
  expect(() => validatePortableSelection({ name: "harbor-python", config: { apiKey: "secret" } }, "verifier")).toThrow(/Credentials/);
});


test("OS-restricted sources reject before creating a cache or fetching bytes", async () => {
  const root = await fixture(); const cache = join(root, "must-not-exist");
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const hostPlatform = process.platform === "win32" ? "linux" : "win32";
  await expect(materializeDirectory({ kind: "archive", url: "https://fixture.invalid/sec.tar.gz", sha256: "a".repeat(64), root: ".", hostPlatform }, cache, signal())).rejects.toThrow(/requires/);
  expect(fetch).not.toHaveBeenCalled(); await expect(access(cache)).rejects.toThrow();
});

test("explicit descriptive metadata is accepted without admitting execution capabilities", async () => {
  const root = await fixture('v2_1_changes = ["description"]\n[environment]\n');
  const prepare = (config: unknown) => loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig(config), new HarborShellVerifier(), signal());
  await expect(prepare({})).rejects.toThrow(/v2_1_changes/);
  expect((await prepare({ tasks: { metadataFields: ["v2_1_changes"] } })).verificationMode).toBe("shared");
  expect(() => parseHarborConfig({ tasks: { metadataFields: ["steps"] } })).toThrow(/Execution/);
});

test("GitHub materialization verifies blob objects and retains the complete dataset directory", async () => {
  const root = await fixture(); const commit = "a".repeat(40); const treeSha = "b".repeat(40);
  const bytes = Buffer.from("locked task");
  const blobSha = createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex");
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith(commit)) return new Response(JSON.stringify({ truncated: false, tree: [{ path: "datasets", mode: "040000", type: "tree", sha: treeSha }] }));
    if (url.endsWith(treeSha + "?recursive=1")) return new Response(JSON.stringify({ truncated: false, tree: ["tasks/a/task.toml", "dataset.toml", "shared/verifier/plugin.py"].map(path => ({ path, mode: "100644", type: "blob", sha: blobSha })) }));
    return new Response(bytes);
  });
  vi.stubGlobal("fetch", fetch);
  const source = { kind: "github" as const, repository: "fixture/bench", revision: commit, path: "datasets" };
  const snapshot = await materializeDirectory(source, join(root, "git-cache"), signal());
  expect(snapshot.files.map(file => file.path)).toEqual(["dataset.toml", "shared/verifier/plugin.py", "tasks/a/task.toml"]);
  expect(await readFile(join(snapshot.directory, "shared/verifier/plugin.py"), "utf8")).toBe("locked task");
  fetch.mockImplementation(async (url: string) => url.includes("raw.githubusercontent.com") ? new Response("corrupted") : url.endsWith(commit) ? new Response(JSON.stringify({ truncated: false, tree: [{ path: "datasets", mode: "040000", type: "tree", sha: treeSha }] })) : new Response(JSON.stringify({ truncated: false, tree: [{ path: "task.toml", mode: "100644", type: "blob", sha: blobSha }] })));
  await expect(materializeDirectory(source, join(root, "bad-git-cache"), signal())).rejects.toThrow(/blob|hash|sha|digest/i);
});


test("GitHub profiles can exclude unrelated links while admitted task links still fail", async () => {
  const root = await fixture();
  const commit = "a".repeat(40);
  const bytes = Buffer.from("task bytes");
  const sha = createHash("sha1").update(Buffer.from("blob " + bytes.length + "\0")).update(bytes).digest("hex");
  const fetch = vi.fn(async (url: string) => url.includes("/git/trees/")
    ? new Response(JSON.stringify({ truncated: false, tree: [
      { path: "tasks/a/task.toml", mode: "100644", type: "blob", sha },
      { path: "tasks/README.md", mode: "120000", type: "blob", sha: "b".repeat(40) },
    ] })) : new Response(bytes));
  vi.stubGlobal("fetch", fetch);
  const source = { kind: "github" as const, repository: "fixture/bench", revision: commit, path: "." };
  const snapshot = await materializeDirectory({ ...source, exclude: ["tasks/README.md"] }, join(root, "excluded"), signal());
  expect(snapshot.files.map(file => file.path)).toEqual(["tasks/a/task.toml"]);
  expect(fetch.mock.calls.some(([url]) => url.includes("raw.githubusercontent.com") && url.endsWith("README.md"))).toBe(false);
  await expect(materializeDirectory(source, join(root, "not-excluded"), signal())).rejects.toThrow(/link or submodule/);
  expect(() => parseHarborConfig({ source: { ...source, exclude: ["../outside"] } })).toThrow(/path/i);
  expect(() => parseHarborConfig({ source: { ...source, exclude: ["x", "x"] } })).toThrow(/Duplicate/);
});

test("unsafe archive entries reject cleanly before extraction", async () => {
  const root = await fixture();
  const header = new Header({ path: "../escaped.txt", type: "File", size: 0 }); header.encode();
  if (!header.block) throw new Error("Missing archive header");
  const bytes = Buffer.concat([header.block, Buffer.alloc(1024)]);
  const server = createServer((_request, response) => response.end(bytes));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  try {
    await expect(materializeDirectory({ kind: "archive", url: "http://127.0.0.1:" + address.port + "/unsafe.tar", sha256: createHash("sha256").update(bytes).digest("hex"), root: "." }, join(root, "unsafe-cache"), signal())).rejects.toThrow(/path/i);
    await expect(access(join(root, "escaped.txt"))).rejects.toThrow();
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("Python task declarations are preserved and cannot use a shell stub", async () => {
  const root = await fixture('[verifier]\nimport_path = "fixture.verifier:Verifier"\n');
  const prepare = (verifier: Parameters<typeof loadGenericHarborTask>[4]) => loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), verifier, signal());
  await expect(prepare(new HarborShellVerifier())).rejects.toThrow(/Python/);
  const privateVerifier = { async prepare(task: import("../../src/core/contracts/verifier.js").VerificationTask) { return { ...task }; }, async verify() { return { rewards: { reward: 1 }, details: {} }; } };
  expect((await prepare(privateVerifier)).verification).toMatchObject({ descriptor: { importPath: "fixture.verifier:Verifier" } });
});

test("the DeepSWE fixture uses official collect and an independent private verification build", async () => {
  const root = join(process.cwd(), "tests/fixtures/deepswe");
  const task = await loadGenericHarborTask(join(root, "valid"), root, "fixture", parseHarborConfig({ defaults: { workdir: "/app" } }), new HarborShellVerifier(), signal());
  expect(task).toMatchObject({ verificationMode: "separate", solveEnv: { image: "fixture/deepswe-task:locked", network: "model-api" }, verifyEnv: { network: "none", build: { visibility: "verifier" } }, transfer: { kind: "artifacts", paths: ["/logs/artifacts/model.patch"] } });
  expect(task.collect?.[0]?.args[1]).toContain("git diff --binary"); expect(JSON.stringify(task.input)).not.toContain("base_commit_hash");
});


test("artifact restoration cannot replace private verifier assets or evaluator runtimes", () => {
  for (const path of ["/tests/test.sh", "/environment/scorer.py", "/opt/evaluator/runtime", "/logs/verifier"]) {
    expect(() => validateTransferSpec({ kind: "artifacts", workdir: "/workspace", paths: [path] }, "/workspace")).toThrow(/Unsafe/);
  }
  expect(() => validateTransferSpec({ kind: "artifacts", workdir: "/workspace", paths: ["/logs/artifacts/model.patch"] }, "/grading")).not.toThrow();
});

test("overlapping declared artifacts cannot weaken required-file checks", async () => {
  const root = await fixture('artifacts = ["/workspace/output", "/workspace/output/required.txt"]\n');
  await expect(loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal())).rejects.toThrow(/Overlapping/);
});


test("Harbor resolves allowlists independently for solve and shared verification", async () => {
  const root = await fixture('schema_version = "1.3"\n[environment]\nnetwork_mode = "allowlist"\nallowed_hosts = ["baseline.example"]\n[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = ["pypi.org", "*.pypi.org"]\n[verifier]\nnetwork_mode = "no-network"\n');
  const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal());
  expect(task.solveEnv.network).toEqual({ kind: "allowlist", allowedHosts: ["pypi.org", "*.pypi.org"] });
  expect(task.verificationNetwork).toBe("none");
  expect(JSON.parse(JSON.stringify(task)).solveEnv.network).toEqual(task.solveEnv.network);
});

test("Harbor inherits environment allowlists and accepts explicit empty verifier allowlists", async () => {
  const root = await fixture('schema_version = "1.3"\n[environment]\nnetwork_mode = "allowlist"\nallowed_hosts = ["baseline.example"]\n[verifier]\nenvironment_mode = "separate"\nnetwork_mode = "allowlist"\n');
  const task = await loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal());
  expect(task.solveEnv.network).toEqual({ kind: "allowlist", allowedHosts: ["baseline.example"] });
  expect(task.verifyEnv?.network).toEqual({ kind: "allowlist", allowedHosts: [] });
});

test.each(['network_mode = "public"\nallowed_hosts = ["pypi.org"]', 'allowed_hosts = ["pypi.org"]', 'network_mode = "allowlist"\nallowed_hosts = ["https://pypi.org"]'])("Harbor rejects invalid phase network declarations: %s", async declaration => {
  const root = await fixture(`schema_version = "1.3"\n[environment]\n[agent]\n${declaration}\n`);
  await expect(loadGenericHarborTask(join(root, "tasks/example"), root, "example", parseHarborConfig({}), new HarborShellVerifier(), signal())).rejects.toThrow(/allowed_hosts/);
});
