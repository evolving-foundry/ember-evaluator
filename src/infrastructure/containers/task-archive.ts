import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerPlatform, PreparationCacheSource } from "../../core/contracts/environment.js";
import type { ArchiveImageAcquisition, ImageRequestContext, NetworkAccess } from "../../core/contracts/network.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { downloadArchiveImage, taskArchiveUrl } from "./archive-image.js";
import { dockerImageName } from "./image-name.js";
import { dockerActivity } from "./progress.js";
import type { DockerCommand } from "./runtime-contract.js";
import { applicationCacheRoot } from "../runtime-installation/install.js";
import { acquireRuntimeLock } from "../runtime-installation/lock.js";

export class DockerTaskArchive {
  constructor(private readonly command: DockerCommand, private readonly settings: ArchiveImageAcquisition,
    private readonly network: NetworkAccess) {}

  async load(context: ImageRequestContext, platform: ContainerPlatform, signal: AbortSignal,
    observe?: (source: PreparationCacheSource) => void): Promise<{ reference: string; pinnedReference: string; id: string }> {
    const url = this.network.sourceUrl(taskArchiveUrl(this.settings, context, platform));
    const tag = dockerImageName("archive", url, context);
    const cache = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "archive-images");
    await mkdir(cache, { recursive: true });
    const release = await acquireRuntimeLock(join(cache, `${createHash("sha256").update(url).digest("hex")}.lock`), signal);
    const metadata = async () => (await this.command(["image", "inspect", tag, "--format", "{{.Id}}"], { signal })).stdout.trim();
    try {
      try {
        const id = await metadata();
        observe?.("image");
        return { reference: tag, pinnedReference: tag, id };
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error) || !/no such (?:image|object)|not found/iu.test(error.message)) throw error;
      }
      const activity = dockerActivity();
      const operationId = randomUUID();
      const report: typeof activity = activity ? event => activity({ ...event, operationId }) : undefined;
      report?.({ message: `Downloading task image archive (${context.phase}, ${platform})`, status: "started" });
      try {
        const archive = await downloadArchiveImage(url, this.settings, this.network, cache, signal, report);
        report?.({ message: "Loading task image archive into Docker" });
        const output = await this.command(["load", "--input", archive], { signal, maxBuffer: 8 * 1024 * 1024 });
        const loaded = /^Loaded image(?: ID)?: (.+)$/mu.exec(output.stdout)?.[1]?.trim();
        if (!loaded) throw new Error("Docker load did not return an image reference");
        await this.command(["image", "tag", loaded, tag], { signal });
        // Read the ID needed by runtime builds; do not compare it with registry metadata.
        const id = await metadata();
        observe?.("reference");
        report?.({ message: "Task image archive loaded", status: "completed" });
        return { reference: tag, pinnedReference: tag, id };
      } catch (error) {
        report?.({ status: signal.aborted ? "cancelled" : "failed" });
        throw error;
      }
    } catch (error) {
      signal.throwIfAborted();
      throw new EvaluatorError("ENV_IMAGE_PULL_FAILED", `Cannot load task image archive for ${context.taskId}/${context.phase}`,
        { component: "docker", operation: "load" }, { cause: error });
    } finally { await release(); }
  }
}
