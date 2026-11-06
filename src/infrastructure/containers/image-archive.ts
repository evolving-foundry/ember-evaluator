import type { DockerCommand } from "./runtime-contract.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { DockerBuildCache } from "./build-cache.js";
import { dockerActivity, withDockerActivity } from "./progress.js";

export type DockerImageArchive = {
  /** Lazily fetch the archive only if the required tag is missing. */
  archive: (signal: AbortSignal, activity?: ActivityListener) => Promise<string>;
  aliases: readonly string[];
};

/** Load and optionally retag an archive without knowing its dataset or transport. */
export class DockerImageArchiveLoader {
  private readonly loads = new DockerBuildCache<void>(false);
  constructor(private readonly command: DockerCommand) {}

  async ensure(tag: string, source: DockerImageArchive, signal: AbortSignal, activity?: ActivityListener): Promise<void> {
    return withDockerActivity(activity, () => this.loads.get(tag, signal, active => this.load(tag, source, active)));
  }

  private async present(tag: string, signal: AbortSignal): Promise<boolean> {
    try {
      await this.command(["image", "inspect", tag, "--format", "{{.Id}}"], { signal });
      return true;
    } catch { signal.throwIfAborted(); return false; }
  }

  private async load(tag: string, source: DockerImageArchive, signal: AbortSignal): Promise<void> {
    if (await this.present(tag, signal)) return;
    const path = await source.archive(signal, dockerActivity());
    signal.throwIfAborted();
    await this.command(["load", "--input", path], { signal, maxBuffer: 8 * 1024 * 1024 });
    if (await this.present(tag, signal)) return;
    for (const alias of source.aliases) {
      if (!await this.present(alias, signal)) continue;
      await this.command(["tag", alias, tag], { signal });
      break;
    }
    if (!await this.present(tag, signal)) throw new Error(`Loaded archive did not provide required image tag: ${tag}`);
  }
}
