import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

export function shellToolName(platform: NodeJS.Platform = process.platform): "powershell" | "bash" {
  return platform === "win32" ? "powershell" : "bash";
}

// Match pi's native PowerShell tool: prefer pwsh, then Windows PowerShell,
// using PATH rather than assuming a PowerShell installation directory.
export async function findPowerShell(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const directories = path
    .split(delimiter)
    .map(value => value.replace(/^"(.*)"$/u, "$1"))
    .filter(isAbsolute);
  for (const name of ["pwsh.exe", "powershell.exe"]) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if ((await stat(candidate)).isFile()) return candidate;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  }
  throw new Error("PowerShell was not found; add pwsh.exe or powershell.exe to PATH");
}
