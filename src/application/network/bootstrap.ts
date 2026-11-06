import { packageManagerCli } from "../../infrastructure/network/package-manager.js";
import { spawn } from "node:child_process";
import { loadNetworkConfig } from "../../config/network.js";
import { networkEnvironment } from "../../infrastructure/network/environment.js";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || !args[separator + 1] || separator !== 0 && (separator !== 2 || args[0] !== "--network"))
  throw new Error("Usage: node scripts/network/bootstrap.mjs [--network network.yaml] -- executable [args...]");
const document = await loadNetworkConfig(separator === 2 ? args[1] : undefined);
const env = networkEnvironment(document.settings, "host", process.env);
env.EVALUATOR_NETWORK_CONFIG = document.origin;
let executable = args[separator + 1]!;
const commandArgs = args.slice(separator + 2);
// Avoid cmd.exe interpolation of arguments on Windows. npm and pnpm ship JS entry points.
if (process.platform === "win32" && (executable === "npm" || executable === "pnpm")) {
  commandArgs.unshift(await packageManagerCli(executable));
  executable = process.execPath;
}
const child = spawn(executable, commandArgs, { env, stdio: "inherit", shell: false, windowsHide: true });
const cancel = () => child.kill("SIGTERM");
process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
child.once("error", () => { process.stderr.write("Cannot start the requested network-configured command\n"); process.exitCode = 1; });
child.once("close", code => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); process.exitCode = code ?? 1; });
