import { readFile, readdir } from "node:fs/promises";
import { parse } from "smol-toml";
import { checkedPath } from "../../../../../../core/artifacts/artifacts.js";

export async function readTomlDocument(path: string): Promise<Record<string, unknown>> {
  const value: unknown = parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("TOML must be a table");
  return value as Record<string, unknown>;
}

export async function readPublicInstruction(taskDir: string, emptyError: () => Error): Promise<string> {
  const prompt = await readFile(await checkedPath(taskDir, "instruction.md"), "utf8");
  if (!prompt.trim()) throw emptyError();
  return prompt;
}

/** The benchmark handles absence according to its policy (Harbor permits image-only tasks). */
export async function inspectPublicDirectory(taskDir: string): Promise<{ path: string; entries: string[] }> {
  const path = await checkedPath(taskDir, "environment");
  return { path, entries: await readdir(path) };
}
