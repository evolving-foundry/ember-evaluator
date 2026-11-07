import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import type { NetworkDocument } from "../core/contracts/network.js";
import { networkDocument, expandNetworkTemplate } from "./network-schema.js";

export async function loadNetworkConfig(path?: string, env: NodeJS.ProcessEnv = process.env): Promise<NetworkDocument> {
  const selected = path ?? env.EVALUATOR_NETWORK_CONFIG;
  const absolute = selected ? resolve(selected) : defaultNetworkConfigPath();
  let content: string;
  try { content = await readFile(absolute, "utf8"); }
  catch (error) {
    if (selected || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(dirname(absolute), { recursive: true });
    const temporary = join(dirname(absolute), `.network-${randomUUID()}.yaml`);
    try {
      await writeFile(temporary, await readFile(new URL("../../playbook/network/official.yaml", import.meta.url)), { flag: "wx", mode: 0o600 });
      // Publish complete bytes without replacing an existing user file, including concurrent first runs.
      try { await link(temporary, absolute); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    } finally { await rm(temporary, { force: true }); }
    content = await readFile(absolute, "utf8");
  }
  const template: unknown = parse(content, { maxAliasCount: 50, uniqueKeys: true }) ?? {};
  // Validate/clone before saving a template; do not expand its references on another node.
  return networkDocument(expandNetworkTemplate(template, new Proxy({}, { get: (_target, key) => typeof key === "string" ? `\${${key}}` : undefined })), env, absolute);
}

export function defaultNetworkConfigPath(): string {
  return join(homedir(), ".ember-evaluator", "network.yaml");
}

export function recommendedNetworkConfigPath(): string {
  return fileURLToPath(new URL("../../playbook/network/mirrors.yaml", import.meta.url));
}
