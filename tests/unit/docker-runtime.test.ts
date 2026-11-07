import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { CPU_VIEW_PATH, nodeCpuViewSource } from "../../src/infrastructure/containers/cpu.js";

test.each(["", "nobody", "1001:1002"])("runtime helpers preserve USER %j when platform digests are not addressable", async user => {
  let built = false;
  let context = "";
  let tag = "";
  const command: DockerCommand = async args => {
    if (args.at(-1) === "{{json .Config.User}}") {
      // Only the image reference is registered; its platform digest is not.
      if (args[4] !== "fixture/base") throw new Error(`No such image: ${args[4]}`);
      return { stdout: JSON.stringify(user), stderr: "" };
    }
    expect(["create", "start", "cp", "compose"]).not.toContain(args[0]);
    if (args[0] === "build") {
      context = args.at(-1) ?? "";
      tag = args[args.indexOf("--tag") + 1] ?? "";
      expect(await readFile(join(context, "cpu-view.cjs"), "utf8")).toBe(nodeCpuViewSource);
      expect(await readFile(join(context, "Dockerfile"), "utf8"))
        .toContain(`COPY --chmod=0444 cpu-view.cjs ${CPU_VIEW_PATH}`);
      const recipe = await readFile(join(context, "Dockerfile"), "utf8");
      expect(recipe).toContain("FROM ${BASE_IMAGE}\nUSER 0:0");
      expect(recipe).toContain("COPY --chmod=0444 docker-process.mjs");
      expect(recipe.endsWith(`USER ${user || "0"}\n`)).toBe(true);
      built = true;
      return { stdout: "", stderr: "" };
    }
    const image = args[4];
    if (image === PINNED_NODE_IMAGE) return { stdout: PINNED_NODE_IMAGE.split("@")[1] + " []", stderr: "" };
    if (image?.includes(":solve-runtime-") && !built) throw new Error("not cached");
    return { stdout: "sha256:" + "a".repeat(64), stderr: "" };
  };
  const runtime = new DockerRuntime(command);
  const ready = await runtime.prepare("fixture/base", [], new AbortController().signal);
  expect(built).toBe(true);
  expect(ready.image).toBe(tag);
  expect(ready.baseDigest).toBe("sha256:" + "a".repeat(64));
  await expect(readFile(join(context, "cpu-view.cjs"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await runtime.prepare("fixture/base", [], new AbortController().signal)).image).toBe(tag);
});

test("runtime cache names distinguish tasks and purposes while reusing each completed image", async () => {
  const images = new Set<string>();
  const builds: string[] = [];
  const command: DockerCommand = async args => {
    const ref = args[4] ?? "";
    if (args[0] === "build") {
      const tag = args[args.indexOf("--tag") + 1]!;
      builds.push(tag); images.add(tag);
      return { stdout: "", stderr: "" };
    }
    if (args.at(-1) === "{{json .Config.User}}") return { stdout: '""', stderr: "" };
    if (ref === PINNED_NODE_IMAGE) return { stdout: PINNED_NODE_IMAGE.split("@")[1] + " []", stderr: "" };
    if (ref.startsWith("ember-evaluator/") && !images.has(ref)) throw new Error("No such image");
    return { stdout: "sha256:" + "a".repeat(64), stderr: "" };
  };
  const scope = { taskId: "terminal-bench/atrx-vep-crispr", phase: "solve" as const };
  const signal = new AbortController().signal;
  const runtime = new DockerRuntime(command);
  const first = await runtime.prepare("base", [], signal, undefined, scope);
  expect((await runtime.prepare("base", [], signal, undefined, scope)).image).toBe(first.image);
  expect((await new DockerRuntime(command).prepare("base", [], signal, undefined, scope)).image).toBe(first.image);
  expect(builds).toHaveLength(1);
  const verify = await runtime.prepare("base", [], signal, undefined, { ...scope, phase: "verify" });
  const other = await runtime.prepare("base", [], signal, undefined, { ...scope, taskId: "terminal-bench/other" });
  expect(verify.image).toMatch(/\/atrx-vep-crispr:verify-runtime-/u);
  expect(other.image).toMatch(/\/other:solve-runtime-/u);
  expect(builds).toHaveLength(3);
});
