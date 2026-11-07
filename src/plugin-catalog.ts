import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DeclaredPluginFlag = { command: "run"; flag: string; description: string; config?: string };
export type InstalledPlugin = { id: string; version: string; entry: string; cli?: string; flags?: DeclaredPluginFlag[] };

const FLAG_PATTERN = /^--([a-z][a-z0-9-]*)(?: +(?:<([a-z][a-z0-9-]*)>|\[([a-z][a-z0-9-]*)\]))?$/u;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid plugin manifest");
  return value as Record<string, unknown>;
}

/** Declarative flags let a plugin extend an existing command without shipping CLI code. */
function pluginFlags(value: unknown): DeclaredPluginFlag[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("Invalid plugin flags");
  const names = new Set<string>();
  return value.map(item => {
    const flag = record(item);
    if (flag.command !== "run") throw new TypeError("Unsupported plugin flag command");
    const syntax = flag.flag;
    if (typeof syntax !== "string") throw new TypeError("Invalid plugin flag");
    const match = FLAG_PATTERN.exec(syntax);
    if (!match) throw new TypeError(`Invalid plugin flag: ${syntax}`);
    if (names.has(match[1]!)) throw new TypeError(`Duplicate plugin flag: --${match[1]}`);
    names.add(match[1]!);
    const description = flag.description;
    if (typeof description !== "string" || !description.trim()) throw new TypeError("Invalid plugin flag description");
    const config = flag.config;
    if (config !== undefined) {
      if (typeof config !== "string" || !/^[a-z][A-Za-z0-9]*$/u.test(config)) throw new TypeError("Invalid plugin flag config");
      if (match[2] === undefined && match[3] === undefined) throw new TypeError(`Plugin flag ${syntax} needs a value placeholder for config`);
    }
    return { command: "run", flag: syntax, description,
      ...(config === undefined ? {} : { config }) };
  });
}

function localPath(base: string, value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) throw new TypeError("Invalid plugin entry path");
  const path = resolve(base, value);
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("Plugin entry escapes its directory");
  return path;
}

/** Unbuilt source checkouts import the TypeScript file each manifest compiles from. */
const SOURCE_RUNTIME = import.meta.url.endsWith(".ts");

function executablePath(base: string, value: unknown): string {
  const declared = localPath(base, value);
  if (!SOURCE_RUNTIME || existsSync(declared)) return declared;
  const rel = relative(base, declared);
  const sourceRel = rel.replace(/^dist[/\\]/u, "").replace(/\.js$/u, ".ts");
  const source = resolve(base, sourceRel);
  return sourceRel !== rel && existsSync(source) ? source : declared;
}

export function readPluginCatalog(root = fileURLToPath(new URL("../", import.meta.url))): InstalledPlugin[] {
  const index = resolve(root, "dist/external-plugins/index.json");
  let entries: { value: unknown; base: string }[];
  if (existsSync(index)) {
    const body = record(JSON.parse(readFileSync(index, "utf8")));
    if (!Array.isArray(body.plugins)) throw new TypeError("Unsupported plugin index");
    entries = body.plugins.map(value => ({ value, base: dirname(index) }));
  } else {
    const directory = resolve(root, "plugins");
    const version: unknown = record(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))).version;
    entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const base = resolve(directory, entry.name);
      const file = resolve(base, "ember-plugin.json");
      if (!existsSync(file)) return [];
      const manifest = record(JSON.parse(readFileSync(file, "utf8")));
      if (manifest.id !== entry.name) throw new TypeError(`Plugin id must match directory ${entry.name}`);
      return [{ value: { ...manifest, version: manifest.version ?? version }, base }];
    }) : [];
  }
  const ids = new Set<string>();
  return entries.map(({ value, base }) => {
    const item = record(value);
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(item.id) || ids.has(item.id)) throw new TypeError("Invalid or duplicate plugin id");
    if (typeof item.version !== "string" || !item.version.trim()) throw new TypeError(`Missing version for plugin ${item.id}`);
    ids.add(item.id);
    const flags = pluginFlags(item.flags);
    return { id: item.id, version: item.version, entry: executablePath(base, item.entry),
      ...(item.cli === undefined ? {} : { cli: executablePath(base, item.cli) }),
      ...(flags.length === 0 ? {} : { flags }) };
  });
}

export async function loadInstalledPlugin(plugin: InstalledPlugin): Promise<unknown> {
  const module: Record<string, unknown> = await import(pathToFileURL(plugin.entry).href);
  return module.default ?? module;
}
