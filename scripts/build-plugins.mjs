import { spawnSync } from "node:child_process";
import { lstat, cp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const FLAG_PATTERN = /^--([a-z][a-z0-9-]*)(?: +(?:<([a-z][a-z0-9-]*)>|\[([a-z][a-z0-9-]*)\]))?$/u;

function localPath(base, path) {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\\")) throw new Error(`Invalid plugin path: ${path}`);
  const target = resolve(base, path);
  const rel = relative(base, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Plugin path escapes directory: ${path}`);
  return target;
}

async function noSymlinks(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Plugin build input is a symlink: ${path}`);
  if (stat.isDirectory()) for (const name of await readdir(path)) await noSymlinks(join(path, name));
}

function pluginFlags(manifest) {
  if (manifest.flags === undefined) return [];
  if (!Array.isArray(manifest.flags)) throw new Error(`Plugin ${manifest.id}: flags must be an array`);
  const names = new Set();
  return manifest.flags.map((value, index) => {
    const label = `Plugin ${manifest.id}: flags[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
    const unknown = Object.keys(value).find(key => !["command", "flag", "description", "config"].includes(key));
    if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`);
    if (value.command !== "run") throw new Error(`${label}.command must be run`);
    if (typeof value.description !== "string" || !value.description.trim()) throw new Error(`${label}.description must be a non-empty string`);
    const match = typeof value.flag === "string" ? FLAG_PATTERN.exec(value.flag) : null;
    if (!match) throw new Error(`${label}.flag must look like "--name", "--name <value>" or "--name [value]"`);
    if (names.has(match[1])) throw new Error(`${label}.flag duplicates --${match[1]}`);
    names.add(match[1]);
    if (value.config !== undefined) {
      if (typeof value.config !== "string" || !/^[a-z][A-Za-z0-9]*$/u.test(value.config)) throw new Error(`${label}.config must be a camelCase identifier`);
      if (match[2] === undefined && match[3] === undefined) throw new Error(`${label}.config requires a value placeholder in flag`);
    }
    return { command: "run", flag: value.flag, description: value.description, ...(value.config === undefined ? {} : { config: value.config }) };
  });
}

export async function buildPlugins(root) {
  const directory = join(root, "plugins");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code !== "ENOENT") throw error; entries = []; }
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const output = localPath(root, "dist/external-plugins");
  const existing = await lstat(output).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (existing?.isSymbolicLink()) throw new Error("Refusing to replace linked plugin output");
  await rm(output, { recursive: true, force: true });
  const plugins = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const base = join(directory, entry.name);
    let manifest;
    try { manifest = JSON.parse(await readFile(join(base, "ember-plugin.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (manifest?.id !== entry.name || !/^[a-z][a-z0-9-]*$/u.test(manifest.id)) throw new Error(`Invalid plugin manifest: ${entry.name}`);
    if (typeof (manifest.version ?? version) !== "string" || !(manifest.version ?? version).trim()) throw new Error(`Missing plugin version: ${entry.name}`);
    localPath(base, manifest.entry);
    if (manifest.cli !== undefined) localPath(base, manifest.cli);
    if (manifest.patch !== undefined) localPath(base, manifest.patch);
    const flags = pluginFlags(manifest);
    const install = manifest.build?.install;
    if (!Array.isArray(install) || !install.length) throw new Error(`Plugin ${entry.name}: build.install is required`);
    for (const item of install) { localPath(base, typeof item === "string" ? item : item.from); localPath(base, typeof item === "string" ? item : item.to); }
    // A custom build script owns its output; root typecheck still covers these sources.
    if (manifest.build.tsconfig !== undefined && manifest.build.script === undefined) {
      const tsconfig = localPath(base, manifest.build.tsconfig);
      await noSymlinks(tsconfig);
      const compiledOutput = localPath(base, "dist");
      const existingOutput = await lstat(compiledOutput).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (existingOutput?.isSymbolicLink()) throw new Error("Refusing to replace linked compiler output");
      await rm(compiledOutput, { recursive: true, force: true });
      const compiled = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", tsconfig, "--outDir", compiledOutput], { cwd: root, stdio: "inherit", windowsHide: true });
      if (compiled.error) throw compiled.error;
      if (compiled.status !== 0) throw new Error(`TypeScript build failed for ${entry.name}`);
    }
    if (manifest.build.script !== undefined) {
      const script = localPath(base, manifest.build.script);
      await noSymlinks(script);
      const built = spawnSync(process.execPath, [script], { cwd: base, stdio: "inherit", windowsHide: true });
      if (built.error) throw built.error;
      if (built.status !== 0) throw new Error(`Build script failed for ${entry.name}`);
    }
    const target = join(root, "dist/external-plugins", entry.name);
    await mkdir(target, { recursive: true });
    for (const item of install) {
      const source = localPath(base, typeof item === "string" ? item : item.from);
      await noSymlinks(source);
      await cp(source, localPath(target, typeof item === "string" ? item : item.to), { recursive: true });
    }
    for (const path of [manifest.entry, ...(manifest.cli ? [manifest.cli] : [])]) {
      if (!(await lstat(localPath(target, path))).isFile()) throw new Error(`Missing installed plugin entry: ${path}`);
    }
    if (manifest.patch !== undefined) await cp(localPath(base, manifest.patch), join(target, "cordis.patch.yaml"));
    await writeFile(join(target, "ember-plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    plugins.push({ id: manifest.id, version: manifest.version ?? version,
      entry: `${entry.name}/${relative(base, localPath(base, manifest.entry)).split(sep).join("/")}`,
      ...(manifest.cli === undefined ? {} : { cli: `${entry.name}/${relative(base, localPath(base, manifest.cli)).split(sep).join("/")}` }),
      ...(flags.length === 0 ? {} : { flags }) });
  }
  await mkdir(join(root, "dist/external-plugins"), { recursive: true });
  await writeFile(join(root, "dist/external-plugins/index.json"), JSON.stringify({ plugins }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await buildPlugins(fileURLToPath(new URL("../", import.meta.url)));
