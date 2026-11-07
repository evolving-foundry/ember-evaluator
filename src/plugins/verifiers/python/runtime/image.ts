import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerCommand } from "../../../../infrastructure/containers/command.js";
import { DockerBuildCache } from "../../../../infrastructure/containers/build-cache.js";
import { dockerBuildNetwork } from "../../../../infrastructure/containers/build-network.js";

const assets = fileURLToPath(new URL("./", import.meta.url));
type ImageCommand = (args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv) => Promise<unknown>;

export function createPythonVerifierImage(
  docker: string,
  command: ImageCommand = (args, active, env) => runDockerCommand(docker, args, { ...(env ? { env } : {}), signal: active, maxBuffer: 8 * 1024 * 1024 }),
  access?: import("../../../../core/contracts/network.js").NetworkAccess,
): (signal: AbortSignal) => Promise<string> {
  // Recheck Docker after completion: a previously built image may have been removed.
  const builds = new DockerBuildCache<string>(false);
  return async signal => {
    signal.throwIfAborted();
    const network = dockerBuildNetwork(access);
    const hash = createHash("sha256").update(JSON.stringify(network.identity));
    for (const file of ["Dockerfile", "worker.py", "workbuddy.py", "build-runtime.py"]) hash.update(await readFile(join(assets, file)));
    const tag = "ember-harbor-verifier:" + hash.digest("hex").slice(0, 24);
    return builds.getImage(docker, tag, signal, async active => {
      // Another instance or process may have built the image while this caller waited.
      try { await command(["image", "inspect", tag], active); return tag; }
      catch (error) {
        active.throwIfAborted();
        if (!(error instanceof Error) || !/no such (?:image|object)/iu.test(error.message)) throw error;
      }
      const context = await mkdtemp(join(tmpdir(), "evaluator-verifier-build-"));
      try {
        await cp(assets, context, { recursive: true });
        await writeFile(join(context, "Dockerfile"), network.recipe(await readFile(join(assets, "Dockerfile"), "utf8")));
        await command(["build", ...network.buildArgs, "--tag", tag, context], active, network.environment);
      } finally { await rm(context, { recursive: true, force: true }); }
      return tag;
    });
  };
}
