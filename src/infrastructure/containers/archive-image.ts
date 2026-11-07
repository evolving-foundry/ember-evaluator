import { join } from "node:path";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { ArchiveImageAcquisition, ImageRequestContext, NetworkAccess } from "../../core/contracts/network.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { DatasetCache } from "../datasets/cache.js";
import { withDatasetActivity } from "../datasets/activity.js";

function segment(value: string): string {
  if (!value || value === "." || value === ".." || /[\\\u0000-\u001f]/u.test(value)) throw new Error("Invalid task archive path segment");
  return encodeURIComponent(value);
}

export function taskArchiveUrl(settings: ArchiveImageAcquisition, context: ImageRequestContext, platform: ContainerPlatform): string {
  const parts = context.taskId.split("/").map(segment);
  // The benchmark download root already identifies the task namespace.
  const task = (parts.length > 1 ? parts.slice(1) : parts).join("/");
  const file = context.service === undefined ? `${context.phase}.tar.gz` : `${context.phase}/services/${segment(context.service)}.tar.gz`;
  return `${settings.baseUrl.replace(/\/$/u, "")}/${task}/${platform}/${file}`;
}

/** Download the selected archive as-is; Docker owns loading its format and contents. */
export async function downloadArchiveImage(url: string, settings: ArchiveImageAcquisition, network: NetworkAccess,
  cacheRoot: string, signal: AbortSignal, activity?: ActivityListener): Promise<string> {
  const target = network.sourceUrl(url);
  const origin = new URL(target).origin;
  const token = settings.provider === "huggingface" && ["https://huggingface.co", network.settings.sources.huggingface].includes(origin)
    ? process.env.HF_TOKEN : settings.provider === "modelscope" && new URL(target).hostname === "modelscope.cn" ? process.env.MODELSCOPE_API_TOKEN : undefined;
  const cache = new DatasetCache(join(cacheRoot, "archives"), network);
  const downloaded = await withDatasetActivity(event => activity?.(event), () => cache.fetch(target, null, signal,
    token ? { authorization: `Bearer ${token}` } : undefined));
  return downloaded.path;
}
