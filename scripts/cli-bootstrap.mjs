#!/usr/bin/env node
import { realpathSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const direct = Boolean(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url);
const checkout = new URL("../src/cli.ts", import.meta.url);

async function pnpm(...args) {
  const windows = process.platform === "win32";
  const executable = windows ? "cmd.exe" : "pnpm";
  const commandArgs = windows ? ["/d", "/s", "/c", `pnpm ${args.join(" ")}`] : args;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`pnpm ${args[0]} failed with exit code ${code ?? "unknown"}`);
}

// Installed distributions do not ship src/ or scripts/. In a checkout, this
// stable launcher updates stale dist before importing the compiled CLI.
if (direct && process.argv[2] === "run" && existsSync(checkout)) {
  const { ensureCheckoutBuild } = await import("../scripts/checkout-build.mjs");
  await ensureCheckoutBuild(fileURLToPath(new URL("../", import.meta.url)), async () => {
    process.stderr.write("Source changes detected; installing dependencies and rebuilding dist...\n");
    await pnpm("install", "--frozen-lockfile");
    await pnpm("build");
  });
}

const { runCli } = await import("./cli-runtime.js");
export { runCli };

if (direct) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("User cancelled", "AbortError"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), undefined, controller.signal);
  } catch (error) {
    const { formatError } = await import("./core/errors/diagnostics.js");
    process.stderr.write(formatError(error) + "\n");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
