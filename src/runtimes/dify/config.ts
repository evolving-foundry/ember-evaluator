import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";

export type DifyOptions = { baseUrl: string; registryPath?: string };

export function parseDifyOptions(value: unknown): DifyOptions {
  const config = expectRecord(value, "agentbundle.dify");
  rejectUnknown(config, ["baseUrl", "registryPath"], "agentbundle.dify");
  const baseUrl = expectNonEmptyString(config.baseUrl, "agentbundle.dify.baseUrl").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseUrl); }
  catch (error) { throw new TypeError("agentbundle.dify.baseUrl must be an absolute HTTP(S) URL", { cause: error }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:v1|workflows\/run)$/.test(url.pathname)) {
    throw new TypeError("agentbundle.dify.baseUrl must be an HTTP(S) service URL without credentials, query, fragment or /v1 suffix");
  }
  return {
    baseUrl,
    ...(config.registryPath === undefined ? {} : {
      registryPath: expectNonEmptyString(config.registryPath, "agentbundle.dify.registryPath"),
    }),
  };
}
