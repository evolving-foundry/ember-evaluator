// Runs the CLI straight from the TypeScript sources:
//   pnpm dev run --tracer http://127.0.0.1:8787 playbook/gsm8k/gsm8k-quick-start.yaml
// The host verifies the packaged Agent runtime at bootstrap, so the runtime assets
// are built once here for the commands that need them instead of a full `pnpm build`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const command = args[0] ?? "--help";

function exec(executable, argv) {
  return new Promise(resolveExec => {
    const child = spawn(executable, argv, { cwd: root, stdio: "inherit" });
    child.once("error", error => {
      process.stderr.write(`[dev] ${executable} failed: ${error.message}\n`);
      resolveExec(1);
    });
    child.once("exit", (code, signal) => resolveExec(signal === null ? code ?? 1 : 130));
  });
}

// Commands that never load the plugin registry can run before any runtime asset exists.
const RUNTIME_FREE = args.includes("--help")
  || args.includes("-h")
  || command.startsWith("-")
  || command.startsWith("kernel-")
  || ["help", "tracer", "report"].includes(command);
const runtimeAssets = [
  "dist/adapters/harness/pi/runner.js",
  "dist/adapters/harness/pi/builtin-provenance.json",
  "dist/package-provenance.json",
].map(path => resolve(root, path));

if (!RUNTIME_FREE && runtimeAssets.some(path => !existsSync(path))) {
  process.stderr.write("[dev] packaging the Agent runtime once (tsc + package-runtime)\n");
  for (const step of [
    ["node_modules/typescript/bin/tsc", ["-p", "tsconfig.build.json"]],
    ["scripts/package-runtime.mjs", []],
  ]) {
    const code = await exec(process.execPath, [step[0], ...step[1]]);
    if (code !== 0) process.exit(code);
  }
}

process.exit(await exec(process.execPath, [
  "--experimental-transform-types",
  "--disable-warning=ExperimentalWarning",
  "--import", resolve(root, "scripts/source-loader.mjs"),
  resolve(root, "src/cli.ts"),
  ...args,
]));
