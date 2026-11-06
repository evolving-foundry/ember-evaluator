import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../../core/contracts/task.js";
import type { DockerCommand } from "./runtime-contract.js";
import { EVALUATOR_NODE_EXECUTABLE } from "./runtime-contract.js";

const target = "/opt/evaluator/session-bootstrap";

/** The host-owned, read-only mount prevents a task from re-enabling its startup. */
export const composeEntrypointSource = String.raw`
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
if (existsSync("${target}/maintenance")) {
  setInterval(() => {}, 3600000);
} else {
  const argv = JSON.parse(readFileSync("${target}/argv.json", "utf8"));
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.code;
}
`;

function argv(value: unknown, label: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string"))
    throw new Error(`Invalid Docker ${label}; expected an argument array`);
  return value;
}

/** Preserve task startup once, then restart only a managed idle process for export. */
export class ComposeEntrypoint {
  private readonly directory: string;
  constructor(root: string, phase: "solve" | "verify") {
    this.directory = join(root, `compose-${phase}-bootstrap`);
  }

  async configure(main: Record<string, JsonValue>, command: DockerCommand, signal: AbortSignal): Promise<void> {
    const entrypoint = main.entrypoint === undefined || main.entrypoint === null
      ? JSON.parse((await command(["image", "inspect", String(main.image), "--format", "{{json .Config.Entrypoint}}"], { signal })).stdout)
      : main.entrypoint;
    const launch = [...argv(entrypoint, "entrypoint"), ...argv(main.command, "command")];
    if (!launch.length || !launch[0]) throw new Error("Docker main service has no startup command");
    await mkdir(this.directory, { mode: 0o755 });
    await chmod(this.directory, 0o755);
    await writeFile(join(this.directory, "entrypoint.mjs"), composeEntrypointSource, { mode: 0o444, flag: "wx" });
    await writeFile(join(this.directory, "argv.json"), JSON.stringify(launch), { mode: 0o444, flag: "wx" });
    await chmod(join(this.directory, "entrypoint.mjs"), 0o444);
    await chmod(join(this.directory, "argv.json"), 0o444);
    if (main.volumes !== undefined && !Array.isArray(main.volumes)) throw new Error("Invalid main service volumes");
    main.volumes = [...(main.volumes ?? []), { type: "bind", source: this.directory, target, read_only: true }];
    main.entrypoint = [EVALUATOR_NODE_EXECUTABLE, `${target}/entrypoint.mjs`];
    main.command = [];
  }

  async enterMaintenance(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try { await writeFile(join(this.directory, "maintenance"), "", { mode: 0o444, flag: "wx" }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    signal.throwIfAborted();
  }
}
