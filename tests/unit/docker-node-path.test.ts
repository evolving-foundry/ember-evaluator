import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { EVALUATOR_NODE_EXECUTABLE, PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { DockerSolverRuntime } from "../../src/infrastructure/containers/solver-runtime.js";

const exec = promisify(execFile);

test("runtime probes inherit the trusted installer Node even without node on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-node-path-"));
  const images = new Map<string, string>();
  const digest = "sha256:" + "a".repeat(64);
  const output: string[] = [];
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") {
      if (args.at(-1)?.includes("RepoDigests")) return { stdout: `${PINNED_NODE_IMAGE.split("@")[1]} []`, stderr: "" };
      const image = images.get(args[4] ?? "");
      if (!image) throw new Error("Image not built");
      return { stdout: image, stderr: "" };
    }
    if (args[0] !== "build") throw new Error("Unexpected Docker command");
    const context = args.at(-1);
    if (context === undefined) throw new Error("Missing build context");
    const dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
    expect(dockerfile).toContain(`RUN ${EVALUATOR_NODE_EXECUTABLE} /opt/evaluator/install-runtime.mjs &&`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    const result = await exec(process.execPath, [join(context, "install-runtime.mjs"), root, join(context, "installation.json")], {
      env: { ...env, PATH: "" },
    });
    output.push(result.stdout.trim());
    const image = args[args.indexOf("--tag") + 1];
    if (image === undefined) throw new Error("Missing image tag");
    images.set(image, digest);
    return { stdout: "", stderr: "" };
  };
  try {
    await writeFile(join(root, "package.json"), "{}");
    const runtime = new DockerSolverRuntime(command, new DockerRuntime(command));
    await runtime.install({ id: "node-path-regression", files: [{ source: join(root, "package.json"), target: "package.json" }],
      commands: [], probes: [{ executable: "node", args: ["-e", "console.log(process.execPath)"] }] }, new AbortController().signal);
    expect(output).toEqual([process.execPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
