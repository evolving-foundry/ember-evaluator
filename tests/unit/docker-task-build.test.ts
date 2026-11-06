import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";
import type { SpawnOptions } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import type { JsonValue } from "../../src/core/contracts/task.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { DockerComposeProject } from "../../src/infrastructure/containers/compose.js";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { readDirectoryModes } from "../../src/infrastructure/filesystem/directory-modes.js";
import { DocOpsDockerEnvironment, parseDocOpsDockerConfig } from "../../plugins/docops/index.js";

// These cases spawn a real Node CLI for Docker queries, including ownership inspection.
vi.setConfig({ testTimeout: 20_000 });

// Run a controlled CLI process so the real environment snapshots and rewrites
// the Dockerfile without requiring a daemon or downloading images.
const fakeDocker = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(1);
const log = process.env.EVALUATOR_TEST_BUILD_LOG;
const digest = "sha256:" + "a".repeat(64);
if (process.env.EVALUATOR_TEST_COMMAND_LOG) fs.appendFileSync(process.env.EVALUATOR_TEST_COMMAND_LOG, JSON.stringify(args) + "\n");
if (args[0] === process.env.EVALUATOR_TEST_FAILED_OPERATION) {
  console.error(process.env.EVALUATOR_TEST_DOCKER_ERROR); process.exit(17);
}
if (args[0] === "load") { fs.writeFileSync(log + ".loaded", "yes"); console.log("Loaded image: fixture/archive:arm64"); }
else if (args[0] === "version") console.log(args.at(-1).includes("APIVersion") ? "1.52 1.52" : process.env.EVALUATOR_TEST_DAEMON_PLATFORM || "linux/amd64");
else if (args[0] === "info") console.log(args.at(-1) === "{{.ID}}" ? log : JSON.stringify([process.env.EVALUATOR_TEST_NODE_MIRROR].filter(Boolean)));
else if (args[0] === "build") {
  if (process.env.EVALUATOR_TEST_BUILD_GATE) {
    fs.appendFileSync(log + ".builds", args[args.indexOf("--tag") + 1] + "\n");
    while (!fs.existsSync(process.env.EVALUATOR_TEST_BUILD_GATE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  fs.writeFileSync(log, fs.readFileSync(args[args.indexOf("--file") + 1], "utf8"));
  const constraints = require("node:path").join(args.at(-1), ".evaluator-pip-constraints.txt");
  if (fs.existsSync(constraints)) fs.writeFileSync(log + ".constraints", fs.readFileSync(constraints));
} else if (args[0] === "create" || args[0] === "stop" || args[0] === "rm") {
  console.log("probe");
} else if (args[0] === "start") {
  console.log(process.env.EVALUATOR_TEST_PROBE_PLATFORM || "linux/x64");
} else if (args[0] === "image" && args[1] === "inspect") {
  if (args.some(arg => arg.includes("-archive-")) && !fs.existsSync(log + ".loaded")) { console.error("No such image"); process.exit(1); }
  if (process.env.EVALUATOR_TEST_SIDECAR_INDEX) {
    const reference = args[args.includes("--platform") ? 4 : 2];
    const selected = "sha256:" + "e".repeat(64);
    const root = "sha256:" + "b".repeat(64);
    if (reference === selected) { console.error("No such image: " + reference); process.exit(1); }
    if (reference.startsWith("fixture/kafka") || reference.includes("-service-kafka-")) {
      const format = args.at(-1);
      if (format === "{{.Os}}/{{.Architecture}}") console.log("linux/amd64");
      else if (format.includes("RepoTags")) console.log(JSON.stringify([root, [], []]));
      else if (format.includes("RepoDigests")) console.log(JSON.stringify([selected, ["fixture/kafka@sha256:" + "d".repeat(64)], "linux", "amd64"]));
      else console.log(args.includes("--platform") ? selected : process.env.EVALUATOR_TEST_SIDECAR_ROOT || root);
      process.exit(0);
    }
  }
  if (args.at(-1) === "[{{json .Id}},{{json .RepoTags}},{{json .RepoDigests}}]") { console.log(JSON.stringify([digest, [], []])); process.exit(0); }
  if (args.at(-1) === "[{{json .Id}},{{json .Os}},{{json .Architecture}}]") { console.log(JSON.stringify([digest, "linux", "amd64"])); process.exit(0); }
  if (args.at(-1) === "{{json .Config.User}}") { console.log(JSON.stringify("")); process.exit(0); }
  if (process.env.EVALUATOR_TEST_NODE_MIRROR && args[4].startsWith("node:")) process.exit(1);
  if (args[4].includes(":solve-task-") && !fs.existsSync(log)) process.exit(1);
  console.log(args.at(-1).includes(".Architecture") ? process.env.EVALUATOR_TEST_IMAGE_PLATFORM || args[3] : args.at(-1).includes("RepoDigests") ? args[4].split("@")[1] + " []" : digest);
} else if (args[0] !== "image" || !["tag", "rm"].includes(args[1])) process.exit(2);
`;

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (executable: string, args: string[], options: SpawnOptions) => executable === "fixture-docker"
      ? actual.spawn(process.execPath, ["-e", fakeDocker, ...args], options)
      : actual.spawn(executable, args, options),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(recipe: string) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-docker-task-build-"));
  roots.push(root);
  const context = join(root, "public");
  await mkdir(context);
  const dockerfile = join(context, "Dockerfile");
  await writeFile(dockerfile, recipe);
  const { files } = await buildFileManifest(context, []);
  const log = join(root, "built-dockerfile.txt");
  vi.stubEnv("EVALUATOR_TEST_BUILD_LOG", log);
  vi.stubEnv("EVALUATOR_CACHE_DIR", join(root, "cache"));
  vi.stubEnv("PIP_INDEX_URL", "https://pypi.example.test/simple");
  vi.stubEnv("EVALUATOR_DEBIAN_MIRROR", "https://debian.example.test");
  vi.stubEnv("EVALUATOR_NODE_MIRROR", "https://node.example.test/dist");
  vi.stubEnv("NPM_CONFIG_REGISTRY", "");
  vi.stubEnv("npm_config_registry", "");
  return {
    environment: new DockerEnvironment({ dockerExecutable: "fixture-docker" }),
    spec: {
      workdir: "/workspace", image: null, initialFiles: [], runtime: [],
      build: { context, dockerfile: "Dockerfile", sourceHash: fingerprintConfig(files as unknown as JsonValue) },
    },
    log, dockerfile, cache: join(root, "cache"),
  };
}

test("per-task pip constraints reach the build snapshot and change the cached image identity", async () => {
  const recipe = "FROM fixture/base\nRUN pip install pytest\n";
  const { spec, log, dockerfile } = await fixture(recipe);
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  for (const constraints of [[], ["pytest<8"], ["pytest>=9"]]) {
    await rm(log, { force: true }); await rm(log + ".constraints", { force: true });
    const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", buildPipConstraints: { "*": ["anyio<4.15"], example: constraints } });
    await environment.materialize(spec, AbortSignal.timeout(15_000), undefined, undefined, { taskId: "example", phase: "solve" });
    const built = await readFile(log, "utf8");
    expect(built.includes("ENV PIP_CONSTRAINT=")).toBe(Boolean(constraints.length));
    if (constraints.length) expect(await readFile(log + ".constraints", "utf8")).toBe(constraints.join("\n") + "\n");
    expect(await readFile(dockerfile, "utf8")).toBe(recipe);
  }
  const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const tags = calls.filter(args => args[0] === "build").map(args => args[args.indexOf("--tag") + 1]);
  expect(tags).toHaveLength(3);
  expect(new Set(tags).size).toBe(3);
}, 30_000);

test("pip constraints for another task do not alter an explicit pytest>=9 build", async () => {
  const { spec, log } = await fixture("FROM fixture/base\nRUN pip install 'pytest>=9'\n");
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", buildPipConstraints: { old: ["pytest<8"] } });
  await environment.materialize(spec, AbortSignal.timeout(15_000), undefined, undefined, { taskId: "constructor", phase: "solve" });
  const built = await readFile(log, "utf8");
  expect(built).not.toContain("PIP_CONSTRAINT");
  expect(built).toContain("RUN pip install 'pytest>=9'");
});

test("materialization names identify task, phase and service and base pins remain unique", async () => {
  const { environment, spec, log } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  const signal = AbortSignal.timeout(15_000);
  const context = { taskId: "terminal-bench/atrx-vep-crispr", phase: "solve" as const };
  const main = { ...spec, image: "fixture/base", services: { redis: { image: "fixture/redis", properties: {} } } };
  const a = await environment.materialize(main, signal, undefined, undefined, context);
  const b = await environment.materialize(main, signal, undefined, undefined, context);
  const verify = await environment.materialize(main, signal, undefined, undefined, { ...context, phase: "verify" });
  expect(a.prepared).toMatchObject({ baseImage: { pinnedReference: expect.stringMatching(/\/atrx-vep-crispr:solve-base-/u) },
    runtime: { image: expect.stringMatching(/\/atrx-vep-crispr:solve-runtime-/u) } });
  expect(verify.prepared).toMatchObject({ baseImage: { pinnedReference: expect.stringMatching(/\/atrx-vep-crispr:verify-base-/u) },
    runtime: { image: expect.stringMatching(/\/atrx-vep-crispr:verify-runtime-/u) } });
  expect(a.prepared).not.toEqual(b.prepared);
  const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const tags = calls.filter(args => args[0] === "image" && args[1] === "tag").map(args => args[3]);
  expect(tags.filter(tag => tag?.includes(":solve-base-"))).toHaveLength(2);
  expect(new Set(tags).size).toBe(tags.length);
  expect(tags.some(tag => tag?.includes(":verify-service-redis-base-"))).toBe(true);
  expect(tags.every(tag => tag?.startsWith("ember-evaluator/atrx-vep-crispr:"))).toBe(true);
});

test.each([
  ["linux/arm64", "fixture/kafka:latest"],
  ["linux/arm64", `fixture/kafka@sha256:${"d".repeat(64)}`],
  ["linux/amd64", "fixture/kafka:latest"],
] as const)("sidecars use an addressable image with the AMD64 platform on %s for %s", async (nativePlatform, image) => {
  const { spec, log } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_DAEMON_PLATFORM", nativePlatform);
  vi.stubEnv("EVALUATOR_TEST_SIDECAR_INDEX", "1");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", platform: "linux/amd64" });
  const signal = AbortSignal.timeout(15_000);
  const context = { taskId: "terminal-bench/payments-pipeline-fix", phase: "solve" as const };
  const ready = await environment.materialize({ ...spec, image: "fixture/main", services: {
    main: { image: null, properties: { depends_on: ["kafka"] } },
    kafka: { image, properties: {} },
  } }, signal, undefined, undefined, context);
  const rootId = `sha256:${"b".repeat(64)}`;
  expect(ready.prepared).toMatchObject({ platform: "linux/amd64", serviceImages: { kafka: rootId } });
  const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.some(args => args.includes(image) && args.includes("--platform") && args.includes("linux/amd64"))).toBe(true);
  expect(calls.some(args => args[0] === "image" && args[1] === "inspect" && args[2]?.includes(":solve-service-kafka-base-") && args.at(-1) === "{{.Id}}" && !args.includes("--platform"))).toBe(true);

  const prepared = ready.prepared;
  if (!prepared || typeof prepared !== "object" || Array.isArray(prepared)) throw new Error("Missing preparation receipt");
  const serviceImages = prepared.serviceImages;
  if (!serviceImages || typeof serviceImages !== "object" || Array.isArray(serviceImages) || typeof serviceImages.kafka !== "string") throw new Error("Missing Kafka image");
  const paths = { root: join(spec.build.context, "attempt"), agent: log, verifier: log, artifacts: log };
  const command = vi.fn(async (args: string[]) => {
    if (args.includes("up")) {
      const document = JSON.parse(await readFile(join(paths.root, "compose-solve.json"), "utf8"));
      // The platform config ID is deliberately not a valid launch reference.
      if (document.services.kafka.image !== rootId) throw new Error(`No such image: ${document.services.kafka.image}`);
      expect(document.services.kafka.platform).toBe("linux/amd64");
    }
    return { stdout: args.includes("ps") ? "c".repeat(64) : "null", stderr: "" };
  });
  const project = new DockerComposeProject(command, "fixture-docker", ready, paths,
    { runId: "run", taskId: context.taskId, attemptId: "attempt" }, "solve");
  try {
    await expect(project.create({ image: `sha256:${"a".repeat(64)}`, platform: "linux/amd64", command: ["node", "idle.mjs"] },
      { kafka: serviceImages.kafka }, {}, signal)).resolves.toBe("c".repeat(64));
    expect(command.mock.calls.some(([args]) => args.includes("--pull") && args.includes("never"))).toBe(true);
  } finally { await project.dispose(signal); }
});

test("sidecar preparation rejects an invalid addressable image ID", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_SIDECAR_INDEX", "1");
  vi.stubEnv("EVALUATOR_TEST_SIDECAR_ROOT", "invalid-id");
  await expect(environment.materialize({ ...spec, image: "fixture/main", services: {
    kafka: { image: "fixture/kafka:latest", properties: {} },
  } }, AbortSignal.timeout(15_000))).rejects.toMatchObject({ code: "ENV_IMAGE_REFERENCE_INVALID" });
});

test("task Dockerfile downloads inherit configured build proxy and network", async () => {
  const { spec, log } = await fixture("FROM fixture/base\nRUN curl https://github.com/example/release\n");
  vi.stubEnv("EVALUATOR_DOCKER_BUILD_NETWORK", "host");
  vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:7890");
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  await new DockerEnvironment({ dockerExecutable: "fixture-docker" }).materialize(spec, AbortSignal.timeout(15_000));
  const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const build = calls.find(args => args[0] === "build" && args.some(arg => arg.includes(":solve-task-")));
  expect(build).toEqual(expect.arrayContaining(["--network", "host", "HTTP_PROXY", "HTTPS_PROXY"]));
  const firstTag = build?.find(arg => arg.includes(":solve-task-"));
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7891");
  await new DockerEnvironment({ dockerExecutable: "fixture-docker" }).materialize(spec, AbortSignal.timeout(15_000));
  const subsequent: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const tags = subsequent.filter(args => args[0] === "image" && args[1] === "inspect").flat().filter(arg => arg.includes(":solve-task-"));
  expect(new Set(tags).size).toBe(2);
  expect(tags).toContain(firstTag);
});

test.each(["public", "verifier"] as const)("%s task builds inherit the npm registry in every stage and invalidate cached images", async visibility => {
  const recipe = "FROM fixture/base AS build\nRUN pnpm install --frozen-lockfile\nFROM build\nUSER node\nRUN npm ci\n";
  const { spec, log, dockerfile } = await fixture(recipe);
  vi.stubEnv("NPM_CONFIG_REGISTRY", "https://packages.example.test/");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  const selected = { ...spec, build: { ...spec.build, visibility } };
  await new DockerEnvironment({ dockerExecutable: "fixture-docker" }).materialize(selected, AbortSignal.timeout(15_000));
  const built = await readFile(log, "utf8");
  for (const name of ["NPM_CONFIG_REGISTRY", "npm_config_registry", "COREPACK_NPM_REGISTRY"])
    expect(built.match(new RegExp("^ARG " + name + "$", "gmu"))).toHaveLength(3);
  const commands: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(commands.find(args => args[0] === "build")).toContain("NPM_CONFIG_REGISTRY=https://packages.example.test");
  vi.stubEnv("NPM_CONFIG_REGISTRY", "https://other-packages.example.test/");
  await new DockerEnvironment({ dockerExecutable: "fixture-docker" }).materialize(selected, AbortSignal.timeout(15_000));
  const updated: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const tags = updated.filter(args => args[0] === "image" && args[1] === "inspect").flat().filter(arg => arg.includes(":solve-task-"));
  expect(new Set(tags).size).toBe(2);
  expect(await readFile(dockerfile, "utf8")).toBe(recipe);
});

test.each([
  ["build", "fixture build failed", "ENV_IMAGE_BUILD_FAILED"],
  ["build", "TimeoutError: build deadline", "ENV_IMAGE_BUILD_TIMEOUT"],
  ["build", "exec format error", "ENV_ARCH_UNSUPPORTED"],
  ["version", "daemon unavailable", "ENV_DOCKER_DAEMON_UNAVAILABLE"],
])("Docker %s failures retain operation and original exit code: %s", async (operation, message, code) => {
  const { environment, spec } = await fixture("FROM fixture/base\nRUN false\n");
  vi.stubEnv("EVALUATOR_TEST_FAILED_OPERATION", operation);
  vi.stubEnv("EVALUATOR_TEST_DOCKER_ERROR", message);
  const failure = await environment.materialize(spec, AbortSignal.timeout(10_000)).catch((error: unknown) => error);
  expect(failure).toMatchObject({ code, details: { operation } });
  if (operation === "build") expect(failure).toMatchObject({ details: { exitCode: 17, originalCode: "ENV_PREPARATION_FAILED" } });
});

test.each(["", "    ", "\t"])("builds task Dockerfiles with %j instruction indentation", async indent => {
  const recipe = `# FROM in a comment\n${indent}from fixture/base AS build\n${indent}RUN echo base\n${indent}FROM build\nWORKDIR /workspace\n`;
  const { environment, spec, log, dockerfile } = await fixture(recipe);
  const ready = await environment.materialize(spec, AbortSignal.timeout(10_000));
  expect(ready.prepared).toMatchObject({ kind: "docker", launchImage: `sha256:${"a".repeat(64)}` });
  expect(ready.preparationTiming?.cache).toEqual({ image: "built", runtime: "image" });
  expect(ready.preparationTiming?.imageMs).toBeGreaterThanOrEqual(0);
  expect(ready.preparationTiming?.runtimeMs).toBeGreaterThanOrEqual(0);
  expect(ready.preparationTiming?.solverMs).toBe(0);
  const built = await readFile(log, "utf8");
  expect(built).toContain(`${indent}from fixture/base AS build\nARG HF_ENDPOINT\nARG PIP_INDEX_URL`);
  expect(built).toContain(`${indent}FROM build\nARG HF_ENDPOINT\nARG PIP_INDEX_URL`);
  expect(built.match(/^ARG PIP_INDEX_URL$/gmu)).toHaveLength(2);
  expect(built).toContain("https://debian.example.test/debian");
  expect(await readFile(dockerfile, "utf8")).toBe(recipe);
});

test("rejects a Dockerfile whose only FROM appears in a comment", async () => {
  const { environment, spec } = await fixture("    # FROM fixture/base\nWORKDIR /workspace\n");
  const onImageReady = vi.fn();
  await expect(environment.materialize(spec, AbortSignal.timeout(10_000), onImageReady))
    .rejects.toThrow("Dockerfile has no FROM instruction");
  expect(onImageReady).not.toHaveBeenCalled();
});

test("independent evaluator environments build a shared task image once", async () => {
  const { spec, log, cache } = await fixture("FROM fixture/base\n");
  const gate = log + ".release";
  vi.stubEnv("EVALUATOR_TEST_BUILD_GATE", gate);
  const jobs = Array.from({ length: 3 }, () => new DockerEnvironment({ dockerExecutable: "fixture-docker" }).materialize(spec, AbortSignal.timeout(15000)));
  const completed = Promise.all(jobs);
  void completed.catch(() => {});
  try {
    await vi.waitFor(async () => expect((await readFile(log + ".builds", "utf8")).trim().split("\n")).toHaveLength(1), { timeout: 5000 });
    await vi.waitFor(async () => expect((await readdir(join(cache, "image-builds"))).filter(file => file.endsWith(".tmp"))).toHaveLength(2), { timeout: 5000 });
    expect((await readFile(log + ".builds", "utf8")).trim().split("\n")).toHaveLength(1);
  } finally { await writeFile(gate, "release\n"); await Promise.allSettled(jobs); }
  await completed;
  expect((await readFile(log + ".builds", "utf8")).trim().split("\n")).toHaveLength(1);
});

test("reports a built task image before starting runtime preparation", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  const runtime = vi.spyOn(DockerRuntime.prototype, "prepare");
  const onImageReady = vi.fn(timing => {
    expect(timing).toMatchObject({ cache: "built" });
    expect(timing.imageMs).toBeGreaterThanOrEqual(0);
    expect(runtime).not.toHaveBeenCalled();
  });
  try {
    await environment.materialize(spec, AbortSignal.timeout(10_000), onImageReady);
    expect(onImageReady).toHaveBeenCalledTimes(1);
    expect(runtime).toHaveBeenCalledTimes(1);
  } finally { runtime.mockRestore(); }
});

test.each(["relative", "absolute"])("prepares external build dependencies using a snapshot with a %s Dockerfile path", async pathKind => {
  const recipe = "FROM fixture/base\n";
  const { spec, log, dockerfile } = await fixture(recipe);
  if (pathKind === "absolute") spec.build.dockerfile = await realpath(dockerfile);
  const activity = vi.fn();
  const dependency = vi.fn(async (snapshot, signal, observe) => {
    signal.throwIfAborted();
    expect(snapshot.build.context).not.toBe(spec.build.context);
    expect(await readFile(join(snapshot.build.context, snapshot.build.dockerfile), "utf8")).toBe(recipe);
    await expect(readFile(log)).rejects.toThrow();
    observe?.({ lines: ["fixture image dependency ready"] });
  });
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", prepareBuild: dependency });
  const onImageReady = vi.fn(() => expect(dependency).toHaveBeenCalledTimes(1));
  await environment.materialize(spec, AbortSignal.timeout(15_000), onImageReady, activity);
  expect(onImageReady).toHaveBeenCalledTimes(1);
  expect(activity).toHaveBeenCalledWith(expect.objectContaining({ lines: ["fixture image dependency ready"] }));
  await environment.materialize(spec, AbortSignal.timeout(15_000));
  const another = new DockerEnvironment({ dockerExecutable: "fixture-docker", prepareBuild: dependency });
  await another.materialize(spec, AbortSignal.timeout(15_000));
  expect(dependency).toHaveBeenCalledTimes(1);
});

test("failed build dependencies stop image creation and can be retried", async () => {
  const { spec, log } = await fixture("FROM fixture/base\n");
  const dependency = vi.fn().mockRejectedValueOnce(new Error("dependency unavailable")).mockResolvedValue(undefined);
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", prepareBuild: dependency });
  const ready = vi.fn();
  await expect(environment.materialize(spec, AbortSignal.timeout(15_000), ready)).rejects.toThrow("dependency unavailable");
  expect(ready).not.toHaveBeenCalled();
  await expect(readFile(log)).rejects.toThrow();
  await environment.materialize(spec, AbortSignal.timeout(15_000), ready);
  expect(dependency).toHaveBeenCalledTimes(2);
  expect(ready).toHaveBeenCalledTimes(1);
});

test("DocOps materializes with the Docker build hook and inherits runtime installation", async () => {
  const { spec, log } = await fixture("FROM harbor-codex-base:2.1.114\n");
  const command = vi.fn(async () => {
    await expect(readFile(log)).rejects.toThrow();
    return { stdout: `sha256:${"a".repeat(64)}`, stderr: "" };
  });
  const environment = new DocOpsDockerEnvironment(parseDocOpsDockerConfig({ dockerExecutable: "fixture-docker" }), undefined, command);
  expect(environment.installRuntime).toBe(DockerEnvironment.prototype.installRuntime);
  const prepared = await environment.materialize(spec, AbortSignal.timeout(15_000));
  expect(prepared.prepared).toMatchObject({ kind: "docker" });
  expect(command).toHaveBeenCalledWith(["image", "inspect", "harbor-codex-base:2.1.114", "--format", "{{.Id}}"], expect.anything());
  await environment.materialize(spec, AbortSignal.timeout(15_000));
  expect(command).toHaveBeenCalledTimes(1);
});

test("rewrites the Node binary URL without changing versions or public task files", async () => {
  const recipe = 'FROM fixture/base\nARG NODE_VERSION=20.18.1\nRUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar xJ -C /usr/local\nRUN curl https://example.test/other.tar.gz\n';
  const { environment, spec, log, dockerfile } = await fixture(recipe);
  await environment.materialize(spec, AbortSignal.timeout(10_000));
  const built = await readFile(log, "utf8");
  expect(built).toContain("https://node.example.test/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz");
  expect(built).toContain("https://example.test/other.tar.gz");
  expect(await readFile(dockerfile, "utf8")).toBe(recipe);
});

test.each(["file:///tmp/node", "https://user:secret@example.test/node", "https://example.test/node?key=secret", "https://example.test/a'$HOME"])("rejects unsafe Node mirror %s", async mirror => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_NODE_MIRROR", mirror);
  expect(() => new DockerEnvironment({ dockerExecutable: "fixture-docker" })).toThrow("network.sources.node.dist");
});

test("uses official download sources when no mirrors are configured", async () => {
  const { spec, log } = await fixture('FROM fixture/base\nRUN curl "https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz"\n');
  vi.stubEnv("PIP_INDEX_URL", "");
  vi.stubEnv("EVALUATOR_DEBIAN_MIRROR", "");
  vi.stubEnv("EVALUATOR_NODE_MIRROR", "");
  await new DockerEnvironment({ dockerExecutable: "fixture-docker" }).materialize(spec, AbortSignal.timeout(10_000));
  const built = await readFile(log, "utf8");
  expect(built).not.toContain("sed -i");
  expect(built).toContain("https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz");
});

test.each([
  { image: "fixture/base:1", expected: "fixture/warm:1" },
  { image: "fixture/base:2", expected: "fixture/base:2" },
  { image: "constructor", expected: "constructor" },
  { image: null, expected: "fixture/warm:1" },
])("pins the exact selected image without recursively mapping $image", async ({ image, expected }) => {
  const { spec } = await fixture("FROM fixture/base\n");
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", image: "fixture/base:1",
    imageOverrides: { "fixture/base:1": "fixture/warm:1", "fixture/warm:1": "fixture/other:1" } });
  const { build, ...prebuilt } = spec;
  const ready = await environment.materialize({ ...prebuilt, image }, AbortSignal.timeout(10_000));
  expect(ready.prepared).toMatchObject({ baseImage: { reference: expected, id: "sha256:" + "a".repeat(64) } });
  expect(ready.image).toBe(image);
});

test("image overrides cannot bypass public Dockerfile source validation", async () => {
  const { spec } = await fixture("FROM fixture/base\n");
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", image: "fixture/base", imageOverrides: { "fixture/base": "fixture/warm" } });
  await expect(environment.materialize({ ...spec, build: { ...spec.build, sourceHash: "changed" } }, AbortSignal.timeout(10_000)))
    .rejects.toThrow("source hash");
});

test("a prebuilt image acquisition failure does not rebuild the available Dockerfile", async () => {
  const { environment, spec, log } = await fixture("FROM fixture/base\nRUN false\n");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  vi.stubEnv("EVALUATOR_TEST_FAILED_OPERATION", "image");
  vi.stubEnv("EVALUATOR_TEST_DOCKER_ERROR", "image is not cached");
  await expect(environment.materialize({ ...spec, image: "fixture/prebuilt@sha256:" + "b".repeat(64) }, AbortSignal.timeout(10_000)))
    .rejects.toThrow("cannot inspect or pull Docker image");
  const commands: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(commands.some(args => args[0] === "pull")).toBe(true);
  expect(commands.some(args => args[0] === "build")).toBe(false);
});

test("task image mappings never replace the pinned internal model gateway", async () => {
  const { spec, log } = await fixture("FROM fixture/base\n");
  const commandLog = log + ".commands";
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", commandLog);
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker",
    imageOverrides: { [PINNED_NODE_IMAGE]: "fixture/must-not-be-gateway" } });
  const { build, ...prebuilt } = spec;
  await environment.materialize({ ...prebuilt, image: "fixture/task", network: "model-api" }, AbortSignal.timeout(10_000));
  const commands = (await readFile(commandLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  expect(commands.some(args => args.includes("fixture/must-not-be-gateway"))).toBe(false);
  expect(commands.some(args => args.includes(PINNED_NODE_IMAGE))).toBe(true);
});

test("the internal gateway uses the explicitly supplied Node reference", async () => {
  const { spec, log } = await fixture("FROM fixture/base\n");
  const origin = "https://fixture.mirror.example.test";
  vi.stubEnv("EVALUATOR_NODE_IMAGE_MIRROR", "");
  vi.stubEnv("EVALUATOR_TEST_NODE_MIRROR", origin);
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", network: new NetworkRuntime(networkDocument({ docker: { mirrors: { "docker.io": origin } } }, {})) });
  const { build, ...prebuilt } = spec;
  const result = await environment.materialize({ ...prebuilt, image: "fixture/task", network: "model-api" }, AbortSignal.timeout(10_000));
  expect(result.prepared).toMatchObject({ gatewayDigest: "sha256:" + "a".repeat(64) });
  const calls = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line) as string[]);
  expect(calls.some(args => args.includes(`${new URL(origin).host}/library/${PINNED_NODE_IMAGE}`))).toBe(true);
  expect(calls.some(args => args[0] === "pull")).toBe(false);
});


test.each(["linux/amd64", "linux/arm64"] as const)("auto uses the Docker server native platform %s", async platform => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_DAEMON_PLATFORM", platform);
  const ready = await environment.materialize(spec, AbortSignal.timeout(10_000));
  expect(ready.prepared).toMatchObject({ platform, platformResolution: { source: "native", execution: "native" } });
});

test("a YAML benchmark requirement shares one emulation probe for concurrent preparations", async () => {
  const { spec, dockerfile } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_DAEMON_PLATFORM", "linux/arm64");
  const log = join(roots.at(-1)!, "commands.jsonl");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log);
  const onWarning = vi.fn();
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", platform: "linux/amd64", onWarning });
  const ready = await Promise.all([1, 2].map(() => environment.materialize(spec, AbortSignal.timeout(15_000))));
  for (const item of ready) expect(item.prepared).toMatchObject({ platform: "linux/amd64",
    platformResolution: { source: "benchmark", execution: "qemu", nativePlatform: "linux/arm64" } });
  expect(onWarning).toHaveBeenCalledTimes(1);
  expect(onWarning).toHaveBeenCalledWith(expect.stringContaining("may reduce performance"));
  const commands: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(commands.filter(args => args[0] === "create")).toHaveLength(1);
  expect(commands.filter(args => args.includes("--platform")).every(args => args[args.indexOf("--platform") + 1] === "linux/amd64")).toBe(true);
  expect(await readFile(dockerfile, "utf8")).toBe("FROM fixture/base\n");
});

test("a task platform declaration cannot be overridden by YAML and runs natively when it matches the node", async () => {
  const { spec, log } = await fixture("FROM fixture/base\n");
  const onWarning = vi.fn();
  const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", platform: "linux/arm64", onWarning });
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  const ready = await environment.materialize({ ...spec, platform: "linux/amd64" }, AbortSignal.timeout(10_000));
  expect(ready.prepared).toMatchObject({ platform: "linux/amd64", platformResolution: { source: "benchmark", execution: "native" } });
  expect(onWarning).not.toHaveBeenCalled();
  const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(calls.some(args => args[0] === "create")).toBe(false);
});

test("auto honors a declared benchmark target and probes emulation instead of rewriting it", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_PROBE_PLATFORM", "linux/arm64");
  const ready = await environment.materialize({ ...spec, platform: "linux/arm64" }, AbortSignal.timeout(10_000));
  expect(ready.prepared).toMatchObject({ platform: "linux/arm64", platformResolution: { source: "benchmark", execution: "qemu" } });
});

test("task build caches are isolated by target platform in a shared environment", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_PROBE_PLATFORM", "linux/arm64");
  const log = join(roots.at(-1)!, "commands.jsonl");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log);
  await environment.materialize({ ...spec, platform: "linux/amd64" }, AbortSignal.timeout(10_000));
  await environment.materialize({ ...spec, platform: "linux/arm64" }, AbortSignal.timeout(10_000));
  const commands: string[][] = (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const tags = commands.filter(args => args[0] === "image" && args[1] === "inspect" && args[4]?.includes(":solve-task-"))
    .map(args => args[4]);
  expect(new Set(tags).size).toBe(2);
});

test("identical public corpora build once across task IDs and retain per-task aliases", async () => {
  const { environment, spec, log } = await fixture("FROM fixture/base\nCOPY corpus /corpus\n");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  const publicSpec = { ...spec, build: { ...spec.build, visibility: "public" as const } };
  for (const taskId of ["qid_7", "qid_9"])
    await environment.materialize(publicSpec, AbortSignal.timeout(15_000), undefined, undefined, { taskId, phase: "solve" });
  const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const builds = calls.filter(args => args[0] === "build" && args.some(arg => arg.includes(":solve-task-")));
  expect(builds).toHaveLength(1);
  const aliases = calls.filter(args => args[0] === "image" && args[1] === "tag" && args[3]?.includes(":solve-task-"));
  expect(aliases.map(args => args[3])).toEqual(expect.arrayContaining([
    expect.stringContaining("/qid-7:solve-task-"), expect.stringContaining("/qid-9:solve-task-"),
  ]));
  expect(new Set(aliases.map(args => args[2])).size).toBe(1);
}, 30_000);

test("an image whose actual architecture differs from the resolved target is invalid infrastructure", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_IMAGE_PLATFORM", "linux/arm64");
  await expect(environment.materialize({ ...spec, image: "fixture/arm-only" }, AbortSignal.timeout(10_000)))
    .rejects.toMatchObject({ code: "ENV_ARCH_UNSUPPORTED", message: expect.stringContaining("resolved target is linux/amd64") });
});


test("private verifier build receipts cannot launch a solve environment", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  const privateSpec = { ...spec, build: { ...spec.build, visibility: "verifier" as const } };
  const root = join(spec.build.context, "attempt");
  await expect(environment.prepare(privateSpec, { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") }, "solve", AbortSignal.timeout(1000))).rejects.toThrow(/Private verifier/);
});

test.skipIf(process.platform === "win32")("task image cache distinguishes file and directory modes without changing the content source lock", async () => {
  const { environment, spec, log } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  await environment.materialize(spec, AbortSignal.timeout(10_000));
  await chmod(join(spec.build.context, "Dockerfile"), 0o600);
  await environment.materialize(spec, AbortSignal.timeout(10_000));
  await chmod(spec.build.context, 0o700);
  await environment.materialize(spec, AbortSignal.timeout(10_000));
  const commands: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const tags = commands.filter(args => args[0] === "image" && args[1] === "inspect" && args[4]?.includes(":solve-task-"))
    .map(args => args[4]);
  expect(new Set(tags).size).toBe(3);
  expect(fingerprintConfig((await buildFileManifest(spec.build.context, [])).files as unknown as JsonValue)).toBe(spec.build.sourceHash);
});

test.skipIf(process.platform === "win32")("strict umask preserves source modes in the Docker build copy", async () => {
  const { environment, spec } = await fixture("FROM fixture/base\n");
  await mkdir(join(spec.build.context, "data"), { mode: 0o750 });
  await writeFile(join(spec.build.context, "data/model.urdf"), "model", { mode: 0o644 });
  await writeFile(join(spec.build.context, "run.sh"), "#!/bin/sh\n", { mode: 0o751 });
  const build = { ...spec.build, sourceHash: fingerprintConfig((await buildFileManifest(spec.build.context, [])).files as unknown as JsonValue) };
  const before = await readDirectoryModes(spec.build.context, new AbortController().signal);
  const run = vi.spyOn(DockerRuntime.prototype, "prepare");
  const originalSpawn = (await import("node:child_process")).spawn;
  const probe = vi.spyOn(await import("node:child_process"), "spawn").mockImplementation((executable, args, options) => {
    if (executable === "fixture-docker" && args?.[0] === "build") {
      const context = args.at(-1);
      if (!context) throw new Error("Missing context");
      const inspect = String.raw`const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[1];
        for (const [name, mode] of [['data', 0o750], ['data/model.urdf', 0o644], ['run.sh', 0o751]]) {
          if ((fs.statSync(path.join(root, name)).mode & 0o777) !== mode) process.exit(42);
        }
        fs.writeFileSync(process.env.EVALUATOR_TEST_BUILD_LOG, fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8'));`;
      return originalSpawn(process.execPath, ["-e", inspect, context], options);
    }
    return originalSpawn(executable, args, options);
  });
  const previous = process.umask(0o077);
  try {
    await environment.materialize({ ...spec, build }, AbortSignal.timeout(10_000));
    expect(run).toHaveBeenCalled();
    expect(await readDirectoryModes(spec.build.context, new AbortController().signal)).toEqual(before);
  } finally { process.umask(previous); probe.mockRestore(); run.mockRestore(); }
});


test("archive selection uses the requested platform and bypasses an existing pinned registry image", async () => {
  const { spec, log } = await fixture("FROM fixture/base\n");
  vi.stubEnv("EVALUATOR_TEST_COMMAND_LOG", log + ".commands");
  vi.stubEnv("EVALUATOR_TEST_DAEMON_PLATFORM", "linux/arm64");
  const network = new NetworkRuntime(networkDocument({ docker: { benchmarks: {
    terminalbench: { method: "archive", provider: "modelscope", baseUrl: "https://modelscope.cn/datasets/team/images/resolve/master/terminalbench4.0" },
  } } }, {}));
  const fetch = vi.spyOn(network, "fetch").mockResolvedValue(new Response("opaque archive bytes"));
  try {
    const environment = new DockerEnvironment({ dockerExecutable: "fixture-docker", benchmarkName: "terminalbench",
      network, platform: "linux/arm64", allowEmulation: false });
    const sourceImage = `fixture/original@sha256:${"d".repeat(64)}`;
    const prepared = await environment.materialize({ ...spec, image: sourceImage, platform: "linux/amd64" },
      AbortSignal.timeout(15000), undefined, undefined, { taskId: "terminal-bench/task-a", phase: "solve" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toBe("https://modelscope.cn/datasets/team/images/resolve/master/terminalbench4.0/task-a/linux/arm64/solve.tar.gz");
    expect(prepared.prepared).toMatchObject({ baseImage: { pinnedReference: expect.stringMatching(/:solve-archive-/u) } });
    const calls: string[][] = (await readFile(log + ".commands", "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(args => args.includes(sourceImage))).toBe(false);
    expect(calls.filter(args => args[0] === "load")).toHaveLength(1);
    expect(calls.some(args => args[0] === "pull")).toBe(false);
  } finally { await network.dispose(); }
}, 20000);
