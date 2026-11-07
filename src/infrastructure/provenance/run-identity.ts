import { readFile } from "node:fs/promises";
import type { RunIdentity } from "../../core/contracts/result.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Actual package name/version plus host runtime; source and dist both sit two levels below package.json. */
export async function loadRunIdentity(): Promise<RunIdentity> {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (!nonEmpty(manifest.name) || !nonEmpty(manifest.version))
    throw new TypeError("Evaluator package.json lacks name/version");
  return {
    evaluator: { name: manifest.name, version: manifest.version },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

/** Persisted manifests are a validation boundary; identity is optional for historical runs. */
