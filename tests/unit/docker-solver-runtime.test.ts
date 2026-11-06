import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { DockerSolverRuntime } from "../../src/infrastructure/containers/solver-runtime.js";

type Build = { image: string; args: string[]; dockerfile: string; installation: { commands: unknown[]; probes: unknown[] } };
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const id = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function docker(images = new Map<string, string>(), user = "") {
  const builds: Build[] = [];
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") {
      const image = args[4]!;
      if (args.at(-1)!.includes("RepoDigests")) return { stdout: `${PINNED_NODE_IMAGE.split("@")[1]} []\n`, stderr: "" };
      const digest = images.get(image);
      if (!digest) throw new Error(`No such image: ${image}`);
      if (args.at(-1) === "{{json .Config.User}}") return { stdout: JSON.stringify(user), stderr: "" };
      return { stdout: `${digest}\n`, stderr: "" };
    }
    if (args[0] === "image" && args[1] === "tag") {
      images.set(args[3]!, images.get(args[2]!)!);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "build") {
      const context = args.at(-1)!;
      const image = args[args.indexOf("--tag") + 1]!;
      builds.push({
        image,
        args: args.slice(0, -1),
        dockerfile: readFileSync(join(context, "Dockerfile"), "utf8"),
        installation: JSON.parse(readFileSync(join(context, "installation.json"), "utf8")),
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      images.set(image, id(image));
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { command, builds, images, runtime: () => new DockerSolverRuntime(command, new DockerRuntime(command)) };
}

async function installation() {
  const root = await mkdtemp(join(tmpdir(), "evaluator-solver-runtime-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"fixture-runtime","version":"1.0.0"}');
  return {
    id: "fixture-runtime",
    files: [{ source: join(root, "package.json"), target: "package.json" }],
    commands: [{ executable: "npm", args: ["ci", "--omit=dev"] }],
    probes: [{ executable: "node", args: ["--version"] }],
  };
}

test("tasks share one runtime installation on the pinned Node image and only copy and probe it", async () => {
  const fake = docker(new Map([["task-a", id("task-a")], ["task-b", id("task-b")]]));
  const solver = fake.runtime(); const spec = await installation(); const signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    solver.prepare("task-a", id("task-a"), spec, signal),
    solver.prepare("task-b", id("task-b"), spec, signal),
  ]);
  const installs = fake.builds.filter(build => build.image.startsWith("ember-evaluator/shared:solver-install-"));
  expect(installs).toHaveLength(1);
  expect(installs[0]!.dockerfile.split("\n")[0]).toBe(`FROM ${PINNED_NODE_IMAGE}`);
  expect(installs[0]!.installation).toEqual({ commands: spec.commands, probes: spec.probes });
  expect(installs[0]!.dockerfile).toContain("/opt/evaluator/install-runtime.mjs && chmod -R a+rX /opt/evaluator-agent");
  expect(installs[0]!.dockerfile).toContain("mkdir -p /opt/evaluator-agent/state && chmod 1777 /opt/evaluator-agent/state");
  const derived = fake.builds.filter(build => build.image.includes(":solve-agent-"));
  expect(derived.map(build => build.image).sort()).toEqual([a.image, b.image].sort());
  expect(a.image).not.toBe(b.image);
  for (const build of derived) {
    expect(build.dockerfile).toContain(`FROM ${installs[0]!.image} AS solver_runtime`);
    expect(build.dockerfile).toContain("COPY --from=solver_runtime /opt/evaluator-agent /opt/evaluator-agent");
    expect(build.dockerfile).not.toContain(PINNED_NODE_IMAGE);
    expect(build.dockerfile).not.toContain("RUN chmod");
    expect(build.installation).toEqual({ commands: [], probes: spec.probes });
    expect(build.args).not.toContain("--build-arg");
  }
  expect(a.runtime).toEqual(b.runtime);
  expect(a.runtime).toMatchObject({ root: "/opt/evaluator-agent", stateRoot: "/opt/evaluator-agent/state", persistent: false });
  await solver.prepare("task-a", id("task-a"), spec, signal);
  expect(fake.builds).toHaveLength(3);
});

test("an installed runtime image is reused by later evaluator processes", async () => {
  const fake = docker(); const spec = await installation(); const signal = new AbortController().signal;
  const first = await Promise.all([fake.runtime().install(spec, signal), fake.runtime().install(spec, signal)]);
  expect(first[0].image).toBe(first[1].image);
  expect(fake.builds).toHaveLength(1);
  const builds = fake.builds.length;
  const again = await fake.runtime().install(spec, signal);
  expect(again).toEqual(first[0]);
  expect(fake.builds).toHaveLength(builds);
});

test("independent evaluator runtimes build each solver image once", async () => {
  const fake = docker(new Map([["task", id("task")]]));
  const spec = await installation(); const signal = AbortSignal.timeout(5000);
  const results = await Promise.all(Array.from({ length: 3 }, () => fake.runtime().prepare("task", id("task"), spec, signal)));
  expect(new Set(results.map(result => result.image)).size).toBe(1);
  expect(fake.builds.filter(build => build.image.includes(":solver-install-"))).toHaveLength(1);
  expect(fake.builds.filter(build => build.image.includes(":solve-agent-"))).toHaveLength(1);
});

test("task-scoped agent names reuse content across processes and keep installation shared", async () => {
  const fake = docker(new Map([["task", id("task")]]));
  const spec = await installation(); const signal = new AbortController().signal;
  const scope = { taskId: "terminal-bench/atrx-vep-crispr", phase: "solve" as const };
  const solver = fake.runtime();
  const a = await solver.prepare("task", id("task"), spec, signal, undefined, scope);
  expect(a.image).toMatch(/^ember-evaluator\/atrx-vep-crispr:solve-agent-[a-f0-9]{24}$/u);
  const before = fake.builds.length;
  expect(await fake.runtime().prepare("task", id("task"), spec, signal, undefined, scope)).toEqual(a);
  expect(fake.builds).toHaveLength(before);
  const b = await solver.prepare("task", id("task"), spec, signal, undefined, { ...scope, taskId: "other/task-b" });
  expect(b.image).toMatch(/^ember-evaluator\/task-b:solve-agent-[a-f0-9]{24}$/u);
  expect(fake.builds.filter(build => build.image.includes(":solver-install-"))).toHaveLength(1);
});

test("solver preparation preserves USER when the platform digest is not an addressable image", async () => {
  const platformDigest = id("amd64-manifest");
  const fake = docker(new Map([["task-index", platformDigest]]), "1001:1002");
  const solver = await fake.runtime().prepare("task-index", platformDigest, await installation(), new AbortController().signal);
  const derived = fake.builds.find(build => build.image === solver.image);
  expect(derived?.dockerfile).toContain("USER 1001:1002\n");
  expect(fake.images.has(platformDigest)).toBe(false);
});

test("solver preparation still rejects a platform digest changed during pinning", async () => {
  const platformDigest = id("amd64-manifest");
  const fake = docker(new Map([["task-index", platformDigest]]));
  const command: DockerCommand = async (args, options) => {
    const result = await fake.command(args, options);
    if (args[0] === "image" && args[1] === "tag" && args[2] === "task-index")
      fake.images.set(args[3]!, id("replacement-manifest"));
    return result;
  };
  const runtime = new DockerSolverRuntime(command, new DockerRuntime(command));
  await expect(runtime.prepare("task-index", platformDigest, await installation(), new AbortController().signal))
    .rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED", message: expect.stringContaining("solver image base tag changed during pinning") });
  expect(fake.builds.some(build => build.image.includes(":solve-agent-"))).toBe(false);
});

test("the runtime install passes a validated npm registry and rejects credentials", async () => {
  const spec = await installation(); const signal = new AbortController().signal;
  vi.stubEnv("NPM_CONFIG_REGISTRY", "https://registry.example.test/npm/");
  const accepted = docker();
  await accepted.runtime().install(spec, signal);
  expect(accepted.builds[0]!.args).toContain("NPM_CONFIG_REGISTRY=https://registry.example.test/npm");
  vi.stubEnv("NPM_CONFIG_REGISTRY", "https://user:secret@registry.example.test/");
  const rejected = docker();
  expect(() => rejected.runtime()).toThrow(/network.sources.npm.registry/);
  expect(rejected.builds).toEqual([]);
});


test("amd64 and arm64 solver installations have distinct identities and execute on the selected platform", async () => {
  const fake = docker();
  const spec = await installation();
  const signal = new AbortController().signal;
  const amd = new DockerSolverRuntime(fake.command, new DockerRuntime(fake.command, PINNED_NODE_IMAGE, "linux/amd64"));
  const arm = new DockerSolverRuntime(fake.command, new DockerRuntime(fake.command, PINNED_NODE_IMAGE, "linux/arm64"));
  const [a, b] = await Promise.all([amd.install(spec, signal), arm.install(spec, signal)]);
  expect(a.identity).not.toBe(b.identity);
  expect(a.image).not.toBe(b.image);
  expect(fake.builds).toHaveLength(2);
  expect(new Set(fake.builds.map(build => build.args[build.args.indexOf("--platform") + 1])))
    .toEqual(new Set(["linux/amd64", "linux/arm64"]));
});
