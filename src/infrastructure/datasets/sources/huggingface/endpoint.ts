export type HuggingFaceTransport = { apiBase: string; fileBase: string };

const DEFAULT_ENDPOINT = "https://huggingface.co";

/** Hub origin. `HF_ENDPOINT=https://hf-mirror.com` replaces huggingface.co for API and file URLs. */
export function huggingfaceEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HF_ENDPOINT?.trim();
  if (!raw) return DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("HF_ENDPOINT must be an http(s) origin");
  }
  const hasPath = url.pathname !== "/" && url.pathname !== "";
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || hasPath) {
    throw new TypeError("HF_ENDPOINT must be an http(s) origin");
  }
  return url.origin;
}

export function huggingfaceTransport(env: NodeJS.ProcessEnv = process.env, network?: import("../../../../core/contracts/network.js").NetworkAccess): HuggingFaceTransport {
  const endpoint = network?.settings.sources.huggingface ?? huggingfaceEndpoint(env);
  return { apiBase: endpoint, fileBase: endpoint };
}
