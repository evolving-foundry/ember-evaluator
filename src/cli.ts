#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runCli, defaultIO } from "./cli/main.js";
import { formatError } from "./core/errors/diagnostics.js";
export { runCli, parseArgs } from "./cli/main.js";
export type { CliIO, Command } from "./cli/main.js";

// Global package installs can invoke the CLI through a symlink or Windows junction.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("User cancelled", "AbortError"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), defaultIO, controller.signal);
  } catch (error) {
    defaultIO.error(formatError(error));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
