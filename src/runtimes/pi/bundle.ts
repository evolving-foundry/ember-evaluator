import type { ErrorCode } from "../../core/errors/registry.js";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Pi extension bundle support for the simpleagent solver.
 *
 * A pi-agent-bundle is a self-contained directory (see pi): a
 * `bundle.yaml` manifest declares extension directories, the bundle ships its
 * own settings.json, skills, instructions and a Python dependency lock. The
 * evaluator never mutates the user's bundle; it stages an isolated copy and
 * points the runner's resource loader at the staged extension entries.
 */

export type PiBundleOptions = {
  /** Bundle root directory containing bundle.yaml. */
  path: string;
  /** Complete replacement for the bundle's settings.json, when provided. */
  settings?: Record<string, unknown>;
};

export type StagedPiBundle = {
  /** Staging directory; the bundle copy lives at `<root>/bundle`. */
  root: string;
  /** Absolute path of the isolated bundle copy. */
  bundlePath: string;
  /** Extension entry files, POSIX paths relative to the bundle root. */
  entries: string[];
  /** pip install specifications from dependencies.lock, in lock order. */
  pythonPackages: string[];
  /** Modules the runtime probe must be able to import. */
  pythonRequiredModules: string[];
};

/** The command owns staging; runtime caches and attempt handles own their copies. */
export async function disposePiBundle(staging: Promise<StagedPiBundle> | undefined): Promise<void> {
  // stagePiBundle removes its temporary directory before rejecting.
  const staged = await staging?.then(value => value, () => undefined);
  if (staged) await rm(staged.root, { recursive: true, force: true });
}

export class PiBundleError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "PiBundleError";
  }
}

/** Normalize a manifest-relative path to a safe POSIX-relative form. */
function bundleRelative(value: string, label: string): string {
  const normalized = value.replace(/^\.\//u, "");
  if (normalized === "" || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `${label} is not a safe relative path: ${value}`);
  }
  return normalized;
}

async function readJson(path: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")) as unknown; }
  catch (error) { throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `${label} is not valid JSON`, { cause: error }); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

type PiBundleManifest = { extensions: string[] };

async function readManifest(bundleRoot: string): Promise<PiBundleManifest> {
  let value: unknown;
  try { value = parse(await readFile(join(bundleRoot, "bundle.yaml"), "utf8")) as unknown; }
  catch (error) { throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "bundle.yaml is missing or unreadable", { cause: error }); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "bundle.yaml must be a mapping");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.kind !== "pi-agent-bundle") {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `unsupported bundle kind: ${String(manifest.kind)}`);
  }
  const extensions = manifest.extensions;
  if (!Array.isArray(extensions) || extensions.length === 0
    || extensions.some(item => typeof item !== "string" || item.trim() === "")) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "bundle.yaml extensions must be a non-empty array of paths");
  }
  return { extensions: extensions.map(item => bundleRelative(item, "bundle.yaml extension")) };
}

/** Resolve the explicit entry files a manifest extension directory declares. */
async function extensionEntries(bundleRoot: string, directory: string): Promise<string[]> {
  const manifest = await readJson(join(bundleRoot, directory, "package.json"), `${directory}/package.json`);
  const pi = manifest.pi;
  if (pi === undefined || typeof pi !== "object" || Array.isArray(pi)) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `${directory}/package.json has no pi field`);
  }
  const declared = (pi as Record<string, unknown>).extensions;
  if (!Array.isArray(declared) || declared.length === 0
    || declared.some(item => typeof item !== "string" || item.trim() === "")) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `${directory}/package.json pi.extensions must be a non-empty array`);
  }
  const entries: string[] = [];
  for (const item of declared) {
    const entry = bundleRelative(item, `${directory} pi.extensions entry`);
    entries.push(`${directory}/${entry}`);
    try {
      await access(join(bundleRoot, directory, entry));
    } catch (error) {
      throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", `${directory}/${entry} does not exist in the bundle`, { cause: error });
    }
  }
  return entries;
}

type PythonDependency = { module: string; package: string; pin: string; kind: string; platformLocked: boolean };

async function readPythonDependencies(bundleRoot: string): Promise<PythonDependency[]> {
  const source = await readFile(join(bundleRoot, "dependencies.lock"), "utf8").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return [];
  let lock: unknown;
  try { lock = JSON.parse(source) as unknown; }
  catch (error) { throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "dependencies.lock is not valid JSON", { cause: error }); }
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "dependencies.lock must be an object");
  }
  const python = (lock as Record<string, unknown>).python;
  if (python === undefined) return [];
  if (python === null || typeof python !== "object" || Array.isArray(python)) {
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "dependencies.lock python must be an object");
  }
  const packages = (python as Record<string, unknown>).packages;
  if (packages === undefined) return [];
  if (!Array.isArray(packages)) throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "dependencies.lock python.packages must be an array");
  const dependencies: PythonDependency[] = [];
  for (const item of packages) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "dependencies.lock python.packages entries must be objects");
    }
    const record = item as Record<string, unknown>;
    const module = record.module;
    const pkg = record.package;
    const pin = record.pin;
    const kind = record.kind;
    if (typeof module !== "string" || typeof pkg !== "string" || typeof pin !== "string" || typeof kind !== "string") {
      throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "dependencies.lock python.packages entries need module, package, pin and kind");
    }
    dependencies.push({
      module,
      package: pkg,
      pin,
      kind,
      // Platform-locked entries (pywin32) cannot be part of a portable recipe:
      // pip would fail the whole install on the other platforms.
      platformLocked: record.requires !== undefined,
    });
  }
  return dependencies;
}

/**
 * Stage an isolated copy of a pi bundle and resolve what the runtime needs
 * from it. The copy keeps the bundle's relative layout, so extensions that
 * locate bundle resources relative to their own file keep working.
 */
export async function stagePiBundle(options: PiBundleOptions, signal: AbortSignal): Promise<StagedPiBundle> {
  signal.throwIfAborted();
  const manifest = await readManifest(options.path);
  signal.throwIfAborted();
  const entries: string[] = [];
  for (const directory of manifest.extensions) entries.push(...await extensionEntries(options.path, directory));
  signal.throwIfAborted();
  const dependencies = await readPythonDependencies(options.path);
  const installable = dependencies.filter(item => (item.kind === "required" || item.kind === "optional") && !item.platformLocked);
  const root = await mkdtemp(join(tmpdir(), "evaluator-pi-bundle-"));
  try {
    const bundleDir = join(root, "bundle");
    await cp(options.path, bundleDir, { recursive: true });
    signal.throwIfAborted();
    await access(join(bundleDir, "bundle.yaml"));
    if (options.settings !== undefined) {
      await writeFile(join(bundleDir, "settings.json"), `${JSON.stringify(options.settings, null, 2)}\n`, "utf8");
    }
    return {
      root,
      bundlePath: bundleDir,
      entries,
      pythonPackages: installable.map(item => `${item.package}==${item.pin}`),
      pythonRequiredModules: dependencies.filter(item => item.kind === "required").map(item => item.module),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error instanceof PiBundleError) throw error;
    throw new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "failed to stage the pi bundle", { cause: error });
  }
}
