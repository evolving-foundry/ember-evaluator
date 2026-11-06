import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { resolvePinnedTaskImage } from "../../src/infrastructure/containers/base-image.js";

const digest = `sha256:${"d".repeat(64)}`;
const id = `sha256:${"a".repeat(64)}`;
const reference = `registry.example.test/bench:task-v1@${digest}`;
const source = `registry.example.test/bench@${digest}`;
const tag = "registry.example.test/bench:task-v1";
const scope = { taskId: "benchmark/task-a", phase: "solve" as const };
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "evaluator-base-image-test-"));
  vi.stubEnv("EVALUATOR_CACHE_DIR", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

type Image = { id: string; digests: string[]; os: string; architecture: string };
function docker(present = true) {
  const calls: string[][] = [];
  const image: Image = { id, digests: [source], os: "linux", architecture: "amd64" };
  const images = new Map<string, Image>();
  let cleanupFails = false;
  let abortOnTag: AbortController | undefined;
  const addSource = () => {
    image.digests = [source];
    for (const name of [reference, source, tag, image.id]) images.set(name, image);
  };
  if (present) addSource();
  const command: DockerCommand = async (args, options) => {
    options?.signal?.throwIfAborted();
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") {
      const found = images.get(args[4]!);
      if (!found) throw new Error(`No such image: ${args[4]}`);
      return { stdout: JSON.stringify([found.id, found.digests, found.os, found.architecture]), stderr: "" };
    }
    if (args[0] === "pull") {
      await new Promise(resolve => setTimeout(resolve, 20));
      addSource();
    } else if (args[0] === "image" && args[1] === "tag") {
      const found = images.get(args[2]!);
      if (!found) throw new Error("No such image");
      images.set(args[3]!, found);
      if (abortOnTag) { abortOnTag.abort(); abortOnTag.signal.throwIfAborted(); }
    } else if (args[0] === "image" && args[1] === "rm") {
      if (cleanupFails) throw new Error("image reference in use");
      images.delete(args.at(-1)!);
      if (args.at(-1) === source) {
        images.delete(reference);
        // Classic Docker may lose registry digests after untagging; retain only the receipt.
        image.digests = [];
      }
    } else throw new Error(`Unexpected command: ${args.join(" ")}`);
    return { stdout: "", stderr: "" };
  };
  return { command, calls, images, image, failCleanup: (value: boolean) => { cleanupFails = value; },
    abortOnTag: (controller?: AbortController) => { abortOnTag = controller; } };
}

const signal = () => new AbortController().signal;

test("pinned task images keep one stable Evaluator name and reuse classic-store receipts without pulling", async () => {
  const fake = docker();
  fake.images.set("other-user/keep:latest", fake.image);
  const a = await resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal());
  expect(a).toMatchObject({ reference, id, pinnedReference: expect.stringMatching(/\/task-a:solve-base-/u) });
  expect(fake.images.has(source)).toBe(false);
  expect(fake.images.has(tag)).toBe(false);
  expect(fake.images.has("other-user/keep:latest")).toBe(true);
  expect(fake.image.digests).toEqual([]);
  const b = await resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal());
  expect(b).toEqual(a);
  expect(fake.calls.filter(args => args[1] === "tag")).toHaveLength(1);
  expect(fake.calls.filter(args => args[0] === "pull")).toHaveLength(0);
  expect(fake.calls.filter(args => args[1] === "rm")).toEqual([
    ["image", "rm", "--no-prune", source], ["image", "rm", "--no-prune", tag],
  ]);
  expect((await readdir(join(directory, "docker-images"))).every(name => name.endsWith(".json"))).toBe(true);
});

test("concurrent tasks share one pinned download and recover the admitted image by ID", async () => {
  const fake = docker(false);
  const [a, b] = await Promise.all([
    resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal()),
    resolvePinnedTaskImage(fake.command, reference, "linux/amd64", { ...scope, taskId: "benchmark/task-b" }, signal()),
  ]);
  expect(a?.id).toBe(id);
  expect(b?.id).toBe(id);
  expect(a?.pinnedReference).not.toBe(b?.pinnedReference);
  expect(fake.calls.filter(args => args[0] === "pull")).toEqual([["pull", "--platform", "linux/amd64", reference]]);
  expect(fake.calls.filter(args => args[1] === "tag")).toHaveLength(2);
});

test("a digest-addressed Evaluator image can be verified without an earlier receipt", async () => {
  const fake = docker();
  fake.image.id = digest;
  fake.images.set(digest, fake.image);
  expect((await resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal()))?.id).toBe(digest);
});

test("platforms have separate stable names and source records", async () => {
  const amd = docker();
  const arm = docker();
  arm.image.architecture = "arm64";
  arm.image.id = `sha256:${"b".repeat(64)}`;
  arm.images.set(arm.image.id, arm.image);
  const a = await resolvePinnedTaskImage(amd.command, reference, "linux/amd64", scope, signal());
  const b = await resolvePinnedTaskImage(arm.command, reference, "linux/arm64", scope, signal());
  expect(a?.pinnedReference).not.toBe(b?.pinnedReference);
  expect(a?.id).not.toBe(b?.id);
  expect((await readdir(join(directory, "docker-images"))).filter(name => name.endsWith(".json"))).toHaveLength(2);
});

test("a replaced Evaluator tag is rejected without deleting source references or overwriting it", async () => {
  const fake = docker();
  const a = await resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal());
  const name = a!.pinnedReference;
  const wrong = { ...fake.image, id: `sha256:${"b".repeat(64)}` };
  fake.images.set(name, wrong);
  const before = fake.calls.length;
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal()))
    .rejects.toMatchObject({ code: "ENV_IMAGE_REFERENCE_INVALID", message: expect.stringContaining("tag was replaced") });
  expect(fake.images.get(name)).toBe(wrong);
  expect(fake.calls.slice(before).every(args => args[1] === "inspect")).toBe(true);
});

test("wrong source digests and platforms are rejected before references are removed", async () => {
  const fake = docker();
  fake.image.digests = [];
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal()))
    .rejects.toMatchObject({ code: "ENV_IMAGE_REFERENCE_INVALID" });
  fake.image.digests = [source];
  fake.image.architecture = "arm64";
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal()))
    .rejects.toMatchObject({ code: "ENV_ARCH_UNSUPPORTED" });
  expect(fake.calls.some(args => args[1] === "tag" || args[1] === "rm")).toBe(false);
});

test("cleanup failure retains the Evaluator tag and receipt and can retry without downloading", async () => {
  const fake = docker();
  fake.failCleanup(true);
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal()))
    .rejects.toMatchObject({ code: "CLEANUP_FAILED" });
  expect([...fake.images.keys()].some(name => name.startsWith("ember-evaluator/"))).toBe(true);
  expect(fake.images.has(source)).toBe(true);
  fake.failCleanup(false);
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal())).resolves.toMatchObject({ id });
  expect(fake.images.has(source)).toBe(false);
  expect(fake.calls.some(args => args[0] === "pull")).toBe(false);
});

test("cancellation after tagging releases the source lock and leaves source content available", async () => {
  const fake = docker();
  const controller = new AbortController();
  fake.abortOnTag(controller);
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, controller.signal)).rejects.toThrow();
  expect(fake.images.has(source)).toBe(true);
  expect((await readdir(join(directory, "docker-images"))).some(name => name.endsWith(".lock"))).toBe(false);
  fake.abortOnTag();
  await expect(resolvePinnedTaskImage(fake.command, reference, "linux/amd64", scope, signal())).resolves.toMatchObject({ id });
});

test("mutable references, internal images and calls without task identity retain the existing path", async () => {
  const fake = docker();
  expect(await resolvePinnedTaskImage(fake.command, tag, "linux/amd64", scope, signal())).toBeNull();
  expect(await resolvePinnedTaskImage(fake.command, reference, "linux/amd64", undefined, signal())).toBeNull();
  expect(await resolvePinnedTaskImage(fake.command, PINNED_NODE_IMAGE, "linux/amd64", scope, signal())).toBeNull();
  expect(await resolvePinnedTaskImage(fake.command, `ember-evaluator/shared@${digest}`, "linux/amd64", scope, signal())).toBeNull();
  expect(fake.calls).toEqual([]);
});
