import { access, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cliOutput, AgentBundleError } from "../agentbundle/cli.js";
import { startLocalProcess } from "../../infrastructure/process/local.js";

export type LocalDsh = {
  source: "DSH_BIN" | "DSH_CHECKOUT" | "PATH";
  entry: string;
  executable: string;
  args: string[];
  extraEnv: Record<string, string>;
  version: string;
};

async function file(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Same precedence as the RSI proposer. A broken explicit selection never falls back. */
export async function selectLocalDsh(env: NodeJS.ProcessEnv): Promise<Omit<LocalDsh, "version">> {
  let entry = env.DSH_BIN;
  let source: LocalDsh["source"] = "DSH_BIN";
  let args: string[] = [];
  let extraEnv: Record<string, string> = {};
  if (entry !== undefined) {
    if (!isAbsolute(entry) || !await file(entry)) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "DSH_BIN must point to an existing absolute file");
  } else if (env.DSH_CHECKOUT !== undefined) {
    source = "DSH_CHECKOUT";
    const checkout = env.DSH_CHECKOUT;
    if (!isAbsolute(checkout)) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "DSH_CHECKOUT must be absolute");
    entry = join(checkout, "apps", "cli", "lib", "bin.js");
    if (!await file(entry)) {
      entry = join(checkout, "apps", "cli", "src", "bin.ts");
      const loader = join(checkout, "node_modules", "tsx", "dist", "esm", "index.mjs");
      if (!await file(entry) || !await file(loader)) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "DSH_CHECKOUT requires a built CLI or tsx and the CLI source");
      args = ["--import", loader];
      extraEnv = { TSX_TSCONFIG_PATH: join(checkout, "tsconfig.json") };
    }
  } else {
    source = "PATH";
    const path = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
    search: for (const directory of path.split(delimiter).filter(Boolean)) {
      for (const ext of extensions) {
        const candidate = resolve(directory.replace(/^"|"$/g, ""), `dsh${ext.toLowerCase()}`);
        if (await file(candidate)) {
          try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); entry = candidate; break search; }
          catch { /* Continue to the next executable on PATH. */ }
        }
      }
    }
    if (!entry) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Cannot find dsh on PATH; install it yourself or set DSH_BIN or DSH_CHECKOUT. Evaluator does not install local DSH.");
  }
  entry = await realpath(entry);
  const javascript = /\.[cm]?[jt]s$/i.test(entry);
  return { source, entry, executable: javascript ? process.execPath : entry, args: javascript ? [...args, entry] : [], extraEnv };
}

/** Launcher keeps Windows shims out of shell-string construction and adapts checkout args for the SDK. */
export async function localDshLauncher(runtime: Pick<LocalDsh, "executable" | "args" | "extraEnv">, directory: string, outputHook?: string): Promise<string> {
  const launcher = join(directory, "dsh-launcher.js");
  const spawnModule = pathToFileURL(createRequire(import.meta.url).resolve("cross-spawn")).href;
  const preload = outputHook === undefined ? undefined : pathToFileURL(outputHook).href;
  const node = runtime.executable === process.execPath;
  const args = preload !== undefined && node ? ["--import", preload, ...runtime.args] : runtime.args;
  const preloadEnv = preload !== undefined && !node
    ? `if(process.env.EVALUATOR_DSH_OUTPUT_DIR)env.NODE_OPTIONS=(env.NODE_OPTIONS??'')+' --import='+${JSON.stringify(preload)};\n` : "";
  await writeFile(launcher, `import spawn from ${JSON.stringify(spawnModule)};\nconst env={...process.env,...${JSON.stringify(runtime.extraEnv)}};\n${preloadEnv}const child=spawn(${JSON.stringify(runtime.executable)},[...${JSON.stringify(args)},...process.argv.slice(2)],{env,stdio:'inherit',windowsHide:true,shell:false});\nchild.on('error',e=>{console.error(e.message);process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});\n`, { mode: 0o600 });
  return launcher;
}

export async function inspectLocalDsh(env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<LocalDsh> {
  signal.throwIfAborted();
  const selected = await selectLocalDsh(env);
  const directory = await mkdtemp(join(tmpdir(), "evaluator-dsh-probe-"));
  try {
    const launcher = await localDshLauncher(selected, directory);
    const output = await cliOutput(startLocalProcess, {
      executable: process.execPath, args: [launcher, "--version"], cwd: directory,
      env: { ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), HOME: directory, USERPROFILE: directory, DSH_HOME: directory },
      inheritEnv: false, input: null,
    }, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    const version = output.trim().match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/)?.[1];
    if (!version) throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "Selected DSH --version did not return a semantic version");
    return { ...selected, version };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
