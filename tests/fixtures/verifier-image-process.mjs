import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPythonVerifierImage } from "../../dist/plugins/verifiers/python/runtime/image.js";
import { DockerRuntime } from "../../dist/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE } from "../../dist/infrastructure/containers/runtime-contract.js";

const root = process.argv[2];
const signal = AbortSignal.timeout(10000);
const command = async (args, signal) => {
  if (args[0] === "image") {
    await appendFile(join(root, "inspections"), `${process.pid}\n`);
    try { await access(join(root, "image")); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error("No such image");
      throw error;
    }
    return;
  }
  await appendFile(join(root, "builds"), `${process.pid}\n`);
  for (;;) {
    try { await readFile(join(root, "release")); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(10, undefined, { signal });
  }
  await writeFile(join(root, "image"), "ready\n");
};
if (process.argv[3] === "runtime") {
  const runtime = new DockerRuntime(async (args, options) => {
    const reference = args[4];
    if (args[0] === "image" && args[1] === "inspect") {
      if (args.at(-1) === "{{json .Config.User}}") return { stdout: '""', stderr: "" };
      if (reference === PINNED_NODE_IMAGE) return { stdout: PINNED_NODE_IMAGE.split("@")[1] + " []", stderr: "" };
      if (reference === "fixture/base") return { stdout: "sha256:" + "a".repeat(64), stderr: "" };
      await command(args, options.signal);
    } else if (args[0] === "build") await command(args, options.signal);
    else if (args[0] !== "image" || args[1] !== "tag") throw new Error(`Unexpected command ${args}`);
    return { stdout: "sha256:" + "a".repeat(64), stderr: "" };
  });
  process.stdout.write((await runtime.prepare("fixture/base", [], signal)).image);
} else {
  process.stdout.write(await createPythonVerifierImage("fixture-docker", command)(signal));
}
