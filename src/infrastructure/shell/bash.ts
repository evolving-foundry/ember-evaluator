import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, normalize } from "node:path";

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function nativeBash(path: string): boolean {
  if (process.platform !== "win32") return true;
  // WSL launchers execute in a different filesystem and cannot use the native
  // workspace paths passed to pi. Never select them as a local Bash runtime.
  return !/(?:^|[\\/])(?:windowsapps|system32|sysnative)(?:[\\/]|$)/iu.test(path);
}

// Kept with the standalone pi runtime so discovery is packaged and fingerprinted
// together with the runner. Local preflight uses the same resolver.
export async function findBash(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const windows = process.platform === "win32";
  const variables = new Map(Object.entries(env).map(([name, value]) => [windows ? name.toUpperCase() : name, value]));
  const variable = (name: string) => variables.get(windows ? name.toUpperCase() : name);
  const override = variable("EMBER_BASH_PATH");
  if (override !== undefined) {
    if (!isAbsolute(override) || !nativeBash(normalize(override)) || !(await executable(override))) {
      throw new Error(
        "EMBER_BASH_PATH must point to an existing absolute native Bash executable (not a WSL launcher)",
      );
    }
    return normalize(override);
  }

  const directories = (variable("PATH") ?? "")
    .split(delimiter)
    .map(path => path.replace(/^"(.*)"$/u, "$1"))
    .filter(path => isAbsolute(path));
  const candidates = directories.map(path => join(path, windows ? "bash.exe" : "bash"));
  if (windows) {
    // Git's installer commonly adds only Git/cmd to PATH, not Git/bin.
    for (const directory of directories) {
      if (await executable(join(directory, "git.exe"))) {
        const root = dirname(directory);
        candidates.push(join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe"));
      }
    }
    const roots = [variable("ProgramFiles"), variable("ProgramFiles(x86)")]
      .filter((path): path is string => path !== undefined && isAbsolute(path))
      .map(path => join(path, "Git"));
    const localAppData = variable("LOCALAPPDATA");
    if (localAppData && isAbsolute(localAppData)) roots.push(join(localAppData, "Programs", "Git"));
    for (const root of roots) candidates.push(join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe"));
  } else {
    candidates.push("/bin/bash", "/usr/bin/bash");
  }
  for (const candidate of new Set(candidates)) {
    if (nativeBash(candidate) && (await executable(candidate))) return candidate;
  }
  throw new Error(
    "Bash was not found; add native Bash to PATH or set EMBER_BASH_PATH to its absolute executable path",
  );
}
