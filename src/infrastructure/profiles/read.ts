import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";
import { parseConfigProfile, type ConfigProfile } from "../../config/profile-schema.js";

export async function readProfileDirectory(directory: URL): Promise<ConfigProfile[]> {
  const names = (await readdir(directory)).filter(name => /\.ya?ml$/u.test(name)).sort();
  return await Promise.all(names.map(async name => parseConfigProfile(parse(await readFile(new URL(name, directory), "utf8"), { maxAliasCount: 100 }))));
}
