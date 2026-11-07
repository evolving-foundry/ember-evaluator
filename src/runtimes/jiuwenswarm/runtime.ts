import type { ErrorCode } from "../../core/errors/registry.js";
import { createHash } from "node:crypto";
import { access, constants, readFile } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";
import { canonicalJson } from "../../core/results/run-manifest.js";
import { agentBundleRuntimeFiles, agentBundleVersionProbe, hashRuntimeSource } from "../agentbundle/runtime-files.js";
import { resolveLinuxUvBinary } from "../../infrastructure/runtime-installation/uv-binary.js";

export async function jiuwenswarmBundleRuntimeInstallation(path: string, environment: string | undefined, signal: AbortSignal): Promise<RuntimeInstallation> {
  return environment === "docker" ? jiuwenswarmDockerRuntimeInstallation(path, signal) : jiuwenswarmRuntimeInstallation(signal);
}

/**
 * Pinned jiuwenswarm runtime the companion repository locks. The upstream
 * distribution registers the PEP 440 version `0.2.5b1` at commit `9b3706f`;
 * this evaluator records the semver release form because semver cannot express
 * `0.2.5b1` and its prerelease form would not satisfy the AgentBundle declared
 * compatibility range (`>=0.2,<0.3`).
 */
export const JIUWENSWARM_VERSION = "0.2.5";
/** Default headless task deadline; agentbundle.jiuwenswarmTimeoutSeconds can override it. */
export const JIUWENSWARM_TIMEOUT_SECONDS = 600;

/** In-image asset layout for the docker solver image. */
export const JIUWENSWARM_DOCKER_BUNDLE_TARGET = "bundle";
export const JIUWENSWARM_DOCKER_HOME_TARGET = "jiuwenswarm/home";
export const JIUWENSWARM_DOCKER_SOURCE_TARGET = "jiuwenswarm-src";
export const JIUWENSWARM_DOCKER_UV_TARGET = "uv-bin/uv";

/**
 * Checkout entries the docker install copies into the solver image. The app
 * source and the packaging metadata are the whole build input; the repository's
 * tests, docs, deploy scripts, lockfiles and `packages/` sub-projects are not
 * part of the installed distribution.
 */
const JIUWENSWARM_DOCKER_SOURCE_ENTRIES: readonly string[] = [
  "pyproject.toml",
  "MANIFEST.in",
  "LICENSE",
  "OPEN_SOURCE_SOFTWARE_NOTICE.md",
  "jiuwenswarm",
  "jiuwenbox",
];

/** Prints this marker when the headless process CLI is importable in the image. */
export const JIUWENSWARM_PROCESS_CLI_MARKER = "jiuwenswarm-process-cli";

/** Check both the lazy CLI entry point and its runtime dependency imports. */
export function jiuwenswarmProcessCliProbe(executable: string): { executable: string; args: string[] } {
  return {
    executable,
    args: [
      "-c",
      `import jiuwenswarm.channels.process_cli.main; import jiuwenswarm.channels.process_cli.client; import jiuwenswarm.server.runtime.agent_adapter.interface_deep; import jiuwenswarm.agents.swarm.assembly; print(${JSON.stringify(JIUWENSWARM_PROCESS_CLI_MARKER)})`,
    ],
  };
}

/** Build-time rewrite of the checkout's git-sourced `openjiuwen` requirement. */
export const jiuwenswarmRewriteRequirements = fileURLToPath(new URL("./assets/rewrite-requirements.mjs", import.meta.url));
const jiuwenswarmRwLockProbe = fileURLToPath(new URL("./assets/probe-rwlock.py", import.meta.url));

export interface JiuwenswarmCommand {
  readonly command: string;
  readonly source: string;
}

export class JiuwenswarmRuntimeError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "JiuwenswarmRuntimeError";
  }
}

export const JIUWENSWARM_PROCESS_CLI_NAME = "jiuwenswarm-process";

const PROCESS_CLI_NAME = JIUWENSWARM_PROCESS_CLI_NAME;

/**
 * Console script layout of the companion checkout's `uv sync` venv: POSIX
 * installs it under `.venv/bin`, Windows under `.venv\Scripts` with an
 * `.exe` suffix. The POSIX entry stays first so a checkout carrying both
 * resolves exactly as before.
 */
const VENV_SCRIPTS: readonly (readonly string[])[] = [
  [".venv", "bin", PROCESS_CLI_NAME],
  [".venv", "Scripts", `${PROCESS_CLI_NAME}.exe`],
  [".venv", "Scripts", PROCESS_CLI_NAME],
];

async function isExecutable(path: string): Promise<boolean> {
  return await access(path, constants.X_OK).then(() => true, () => false);
}

async function scanPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const pathEnv = env["PATH"] ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve the headless `jiuwenswarm-process` CLI for launching attempts:
 * `JIUWENSWARM_BIN` explicitly (invalid → hard `ENV_RUNTIME_INSTALL_FAILED`), else the
 * companion checkout's `uv sync` venv (`JIUWENSWARM_CHECKOUT`), else PATH. Pure
 * path resolution — no version probe (the host runtime is trusted like pi). A
 * missing runtime returns undefined so prepare can report a precise error.
 */
export async function resolveJiuwenswarmCommand(
  env: NodeJS.ProcessEnv = process.env,
): Promise<JiuwenswarmCommand | undefined> {
  const explicit = env["JIUWENSWARM_BIN"];
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit))
      throw new JiuwenswarmRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `JIUWENSWARM_BIN must be an absolute path, got ${JSON.stringify(explicit)}`,
      );
    if (!(await isExecutable(explicit)))
      throw new JiuwenswarmRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `JIUWENSWARM_BIN points to a missing or non-executable file: ${explicit}`,
      );
    return { command: explicit, source: "JIUWENSWARM_BIN" };
  }
  const checkout = env["JIUWENSWARM_CHECKOUT"];
  if (checkout !== undefined && checkout !== "") {
    for (const parts of VENV_SCRIPTS) {
      const candidate = join(checkout, ...parts);
      if (await isExecutable(candidate)) return { command: candidate, source: "JIUWENSWARM_CHECKOUT" };
    }
  }
  const found = await scanPath(PROCESS_CLI_NAME, env);
  if (found !== undefined) return { command: found, source: `PATH:${PROCESS_CLI_NAME}` };
  return undefined;
}

/**
 * jiuwenswarm is a host-provided runtime (`JIUWENSWARM_BIN` /
 * `JIUWENSWARM_CHECKOUT` / PATH, materialized by the companion repo's `uv
 * sync`), so the evaluator only vendors the AgentBundle SDK assets it needs to
 * verify and install a bundle. No harness binary is downloaded here.
 */
export async function jiuwenswarmRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const files = await agentBundleRuntimeFiles();
  const hash = createHash("sha256").update("jiuwenswarm-runtime-sdk-1");
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  hash.update(JIUWENSWARM_VERSION);
  const recipe = {
    files,
    commands: [],
    probes: [agentBundleVersionProbe()],
  };
  hash.update(canonicalJson({ probes: recipe.probes }));
  return { ...recipe, id: `jiuwenswarm:${hash.digest("hex")}`, cacheName: `jiuwenswarm-${JIUWENSWARM_VERSION}` };
}

/**
 * Resolve the companion checkout the docker install bakes into the solver
 * image. The checkout — not the PyPI release — is the runtime source of truth:
 * only the pinned revision registers the headless `jiuwenswarm-process` entry
 * point, and the released `workswarm` distributions do not carry it at all.
 */
async function resolveJiuwenswarmCheckout(): Promise<string> {
  const checkout = process.env["JIUWENSWARM_CHECKOUT"] ?? "";
  if (checkout === "")
    throw new JiuwenswarmRuntimeError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "docker jiuwenswarm bundles require JIUWENSWARM_CHECKOUT pointing at the pinned workswarm checkout",
    );
  if (!isAbsolute(checkout))
    throw new JiuwenswarmRuntimeError(
      "ENV_RUNTIME_INSTALL_FAILED",
      `JIUWENSWARM_CHECKOUT must be an absolute path, got ${JSON.stringify(checkout)}`,
    );
  for (const entry of JIUWENSWARM_DOCKER_SOURCE_ENTRIES) {
    const present = await access(join(checkout, entry), constants.R_OK).then(() => true, () => false);
    if (!present)
      throw new JiuwenswarmRuntimeError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `JIUWENSWARM_CHECKOUT is not the pinned workswarm checkout: ${entry} is missing from ${checkout}`,
      );
  }
  return checkout;
}

/** Require portable wheels built from the companion checkout's Git-pinned SDK dependencies. */
async function resolveDependencyWheel(variable: string, distribution: string): Promise<{ source: string; target: string }> {
  const source = process.env[variable] ?? "";
  if (!isAbsolute(source) || !basename(source).startsWith(`${distribution}-`) || !source.endsWith("-py3-none-any.whl"))
    throw new JiuwenswarmRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `${variable} must point at an absolute pure Python wheel built from the checkout's pinned Git dependency`);
  if (!(await access(source, constants.R_OK).then(() => true, () => false)))
    throw new JiuwenswarmRuntimeError("ENV_RUNTIME_INSTALL_FAILED", `${variable} wheel is missing or unreadable: ${source}`);
  return { source, target: `jiuwenswarm/deps/${basename(source)}` };
}

/** Bake the checkout, pinned dependency wheels, Linux uv and bundle into the solver image. */
export async function jiuwenswarmDockerRuntimeInstallation(
  bundleDir: string,
  signal: AbortSignal,
): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const checkout = await resolveJiuwenswarmCheckout();
  const [openjiuwenWheel, routerWheel] = await Promise.all([
    resolveDependencyWheel("JIUWENSWARM_OPENJIUWEN_WHEEL", "openjiuwen"),
    resolveDependencyWheel("JIUWENSWARM_INTELLI_ROUTER_WHEEL", "intelli_router"),
  ]);
  const [uv, agentBundleFiles, rewriteRequirements] = await Promise.all([
    resolveLinuxUvBinary(signal, message => new JiuwenswarmRuntimeError("ENV_RUNTIME_INSTALL_FAILED", message)),
    agentBundleRuntimeFiles(),
    readFile(jiuwenswarmRewriteRequirements, { signal }),
  ]);
  const home = `{root}/${JIUWENSWARM_DOCKER_HOME_TARGET}`;
  const source = `{root}/${JIUWENSWARM_DOCKER_SOURCE_TARGET}`;
  const uvBin = `{root}/${JIUWENSWARM_DOCKER_UV_TARGET}`;
  const uvEnv = {
    UV_PYTHON_INSTALL_DIR: "{root}/uv-python",
    UV_CACHE_DIR: "{root}/.uv-cache",
    // The build container may sit behind a slow egress (no proxy is forwarded
    // into image builds); the full dependency closure exceeds uv's 30s default.
    UV_HTTP_TIMEOUT: "300",
  };
  const files = [
    ...agentBundleFiles,
    { source: jiuwenswarmRewriteRequirements, target: "jiuwenswarm/rewrite-requirements.mjs" },
    { source: jiuwenswarmRwLockProbe, target: "jiuwenswarm/probe-rwlock.py" },
    ...JIUWENSWARM_DOCKER_SOURCE_ENTRIES.map(entry => ({
      source: join(checkout, entry),
      target: `${JIUWENSWARM_DOCKER_SOURCE_TARGET}/${entry}`,
    })),
    { source: uv.path, target: JIUWENSWARM_DOCKER_UV_TARGET },
    { source: bundleDir, target: JIUWENSWARM_DOCKER_BUNDLE_TARGET },
    openjiuwenWheel,
    routerWheel,
  ];
  const commands: RuntimeInstallation["commands"] = [
    {
      executable: "node",
      args: [
        "{root}/jiuwenswarm/rewrite-requirements.mjs",
        `${source}/pyproject.toml`,
        `{root}/${openjiuwenWheel.target}`,
        `{root}/${routerWheel.target}`,
      ],
      cwd: ".",
      env: {},
    },
    { executable: uvBin, args: ["venv", "--python", "3.12", home], cwd: ".", env: uvEnv },
    {
      executable: uvBin,
      args: ["pip", "install", "--override", `${source}/evaluator-overrides.txt`, "--python", `${home}/bin/python`, source],
      cwd: ".",
      env: uvEnv,
    },
    { executable: uvBin, args: ["cache", "clean"], cwd: ".", env: { UV_CACHE_DIR: uvEnv.UV_CACHE_DIR } },
  ];
  const probes: RuntimeInstallation["probes"] = [
    agentBundleVersionProbe(),
    {
      executable: `${home}/bin/python`,
      args: ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)"],
    },
    jiuwenswarmProcessCliProbe(`${home}/bin/python`),
    { executable: `${home}/bin/python`, args: ["{root}/jiuwenswarm/probe-rwlock.py"] },
  ];
  const hash = createHash("sha256").update("jiuwenswarm-docker-runtime-1").update(rewriteRequirements).update(uv.version);
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  hash.update(canonicalJson({ commands, probes }));
  return { id: `jiuwenswarm-docker:${hash.digest("hex")}`, cacheName: `jiuwenswarm-${JIUWENSWARM_VERSION}`, files, commands, probes };
}
