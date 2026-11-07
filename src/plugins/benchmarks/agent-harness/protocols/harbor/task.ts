import type { HardwareKind } from "../../../../../core/contracts/hardware.js";
import { gpuRequirementMessage } from "../../../../../core/policies/hardware.js";
import { lstat, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { readComposeServices } from "./readers/compose.js";
import { TomlError } from "smol-toml";
import type { EnvironmentSpec } from "../../../../../core/contracts/environment.js";
import type { PreparedTask, PreparedStep, JsonValue, PublicTask, PhaseTimeoutOverrides } from "../../../../../core/contracts/task.js";
import type { Verifier } from "../../../../../core/contracts/verifier.js";
import { buildFileManifest, checkedPath } from "../../../../../core/artifacts/artifacts.js";
import { normalizeAllowedHosts } from "../../../../../core/policies/network-policy.js";
import { fingerprintConfig } from "../../../../../core/results/run-manifest.js";
import { readPublicInstruction, readTomlDocument } from "./readers/task-files.js";
import { HarborTaskError } from "./compatibility.js";
import { inferDockerWorkdir } from "./workdir.js";
import type { HarborConfig } from "./config.js";

function invalid(message: string): never { throw new HarborTaskError("TASK_DATA_INVALID", message); }
function unsupported(message: string): never { throw new HarborTaskError("BENCHMARK_UNSUPPORTED", message); }
function table(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${label} must be a table`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[], label: string): void {
  for (const name of Object.keys(value)) if (!names.includes(name)) unsupported(`Unsupported task capability: ${label}.${name}`);
}
function positive(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483) return invalid(`Invalid ${label}`);
  return value;
}
function environmentVariables(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(Object.entries(table(value, label)).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof value !== "string" || value.includes("\0")) invalid(`Invalid ${label}.${key}`);
    return [key, value as string];
  }));
}
function network(value: Record<string, unknown>): NonNullable<EnvironmentSpec["network"]> {
  if (value.network_mode === "allowlist") {
    try { return { kind: "allowlist", allowedHosts: normalizeAllowedHosts(value.allowed_hosts ?? []) }; }
    catch (cause) { throw new HarborTaskError("TASK_DATA_INVALID", `Invalid allowed_hosts: ${cause instanceof Error ? cause.message : "invalid domain rules"}`, { cause }); }
  }
  if (value.allowed_hosts !== undefined) invalid("allowed_hosts requires network_mode = allowlist");
  if (value.network_mode !== undefined && value.network_mode !== "public" && value.network_mode !== "no-network")
    unsupported(`Unsupported network_mode: ${String(value.network_mode)}`);
  if (value.allow_internet !== undefined && typeof value.allow_internet !== "boolean") invalid("allow_internet must be boolean");
  return value.network_mode === "no-network" || (value.network_mode === undefined && value.allow_internet === false) ? "none" : "bridge";
}
function phaseNetwork(phase: Record<string, unknown>, baseline: Record<string, unknown>): NonNullable<EnvironmentSpec["network"]> {
  if (phase.network_mode === undefined) {
    if (phase.allowed_hosts !== undefined) invalid("allowed_hosts requires an explicit allowlist phase policy");
    return network(baseline);
  }
  return network(phase);
}
function path(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\0]/u.test(value) ||
      posix.normalize(value) !== value || value === "/") return invalid(`Invalid absolute container path: ${label}`);
  return value.replace(/\/+$/u, "");
}
function declaredImage(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) invalid(`Invalid ${label}`);
  return value;
}

function checkHardware(declaration: Record<string, unknown>, hardware: HardwareKind, label: string): void {
  if (declaration.gpu !== undefined && typeof declaration.gpu !== "boolean") invalid(`${label}.gpu must be boolean`);
  if (declaration.gpus !== undefined && (typeof declaration.gpus !== "number" || !Number.isSafeInteger(declaration.gpus) || declaration.gpus < 0))
    invalid(`${label}.gpus must be a nonnegative integer`);
  if (declaration.gpu_types !== undefined && (!Array.isArray(declaration.gpu_types) ||
    declaration.gpu_types.some(value => typeof value !== "string" || !value.trim()))) invalid(`${label}.gpu_types must be an array of nonempty strings`);
  const fields = [declaration.gpu === true ? "gpu" : null,
    typeof declaration.gpus === "number" && declaration.gpus > 0 ? "gpus" : null,
    Array.isArray(declaration.gpu_types) && declaration.gpu_types.length ? "gpu_types" : null].filter(value => value !== null);
  if (fields.length) unsupported(gpuRequirementMessage(hardware, fields.map(field => `${label}.${field}`).join(", ")));
}

async function environment(
  declaration: Record<string, unknown>, context: string, workdir: string, visibility: "public" | "verifier",
  phase: "solve" | "verify",
  hardware: HardwareKind, requirement: string,
  parsedServices?: EnvironmentSpec["services"],
): Promise<EnvironmentSpec> {
  fields(declaration, ["docker_image", "workdir", "build_timeout_sec", "cpus", "memory", "storage", "memory_mb", "storage_mb",
    "gpus", "gpu", "gpu_types", "mcp_servers", "env", "os", "platform", "allow_internet", "network_mode", "allowed_hosts", "skills_dir", "healthcheck"], "environment");
  if (declaration.skills_dir !== undefined) {
    const skills = path(declaration.skills_dir, "environment.skills_dir");
    if (["/tests", "/solution", "/environment", "/logs/verifier", "/opt/evaluator", "/opt/evaluator-agent"].some(root => skills === root || skills.startsWith(root + "/")))
      invalid("Task skills must not expose private verification or evaluator runtime directories");
  }
  if (declaration.mcp_servers !== undefined && !Array.isArray(declaration.mcp_servers)) invalid("mcp_servers must be an array");
  if (declaration.os !== undefined && declaration.os !== "linux") unsupported("Only Linux task environments are supported");
  const platform = declaration.platform;
  if (platform !== undefined && platform !== "linux/amd64" && platform !== "linux/arm64") unsupported("Unsupported task platform");
  const resources: NonNullable<EnvironmentSpec["resources"]> = {};
  if (declaration.cpus !== undefined) resources.cpus = positive(declaration.cpus, "environment.cpus");
  for (const key of ["memory", "storage"] as const) {
    const mb = declaration[`${key}_mb`];
    const raw = declaration[key];
    if (mb !== undefined && raw !== undefined) invalid(`Cannot declare both ${key} and ${key}_mb`);
    if (mb !== undefined) resources[key] = `${positive(mb, `${key}_mb`)}m`;
    else if (raw !== undefined) {
      if (typeof raw !== "string" || !/^[1-9][0-9]*(?:[kKmMgG](?:[bB])?)?$/u.test(raw)) invalid(`Invalid environment.${key}`);
      resources[key] = raw as string;
    }
  }
  const explicitImage = declaredImage(declaration.docker_image, "docker_image");
  const services = parsedServices ?? await readComposeServices(context, visibility, explicitImage, hardware, requirement);
  const main = services?.main;
  const hostsOnly = services && Object.keys(services).length === 1 && main && !main.build &&
    Object.keys(main.properties).length === 1 && Array.isArray(main.properties.extra_hosts) &&
    main.properties.extra_hosts.length === 1 && main.properties.extra_hosts[0] === "host.docker.internal:host-gateway";
  const image = explicitImage ?? main?.image ?? undefined;
  const dockerfile = await lstat(join(context, "Dockerfile")).catch(() => null);
  const build = dockerfile?.isFile() && image === undefined;
  if (!build && !main?.build && image === undefined) unsupported(`Missing Docker image or Dockerfile in ${visibility} environment`);
  const spec: EnvironmentSpec = { workdir, image: typeof image === "string" ? image : null, runtime: [], initialFiles: [],
    resources, env: environmentVariables(declaration.env, "environment.env"), network: network(declaration),
    ...(platform === undefined ? {} : { platform }),
    ...(hostsOnly ? { extraHosts: ["host.docker.internal:host-gateway"] } : services ? { services } : {}) };
  if (main?.build && image === undefined) spec.build = main.build;
  else if (build) {
    const manifest = await buildFileManifest(context, []);
    if (manifest.missing.length) invalid("Unsafe environment build context");
    spec.build = { context, dockerfile: "Dockerfile", sourceHash: fingerprintConfig(manifest.files as unknown as JsonValue), visibility };
  }
  if (declaration.healthcheck !== undefined) {
    const health = table(declaration.healthcheck, "environment.healthcheck");
    fields(health, ["command", "interval_sec", "timeout_sec", "retries", "start_period_sec", "start_interval_sec"], "environment.healthcheck");
    if (typeof health.command !== "string" || !health.command.trim()) invalid("Healthcheck command must be non-empty");
    const start = health.start_period_sec ?? 0;
    if (typeof start !== "number" || !Number.isFinite(start) || start < 0) invalid("Invalid healthcheck.start_period_sec");
    const retries = positive(health.retries ?? 3, "healthcheck.retries");
    if (!Number.isInteger(retries)) invalid("Healthcheck retries must be an integer");
    const healthcheck = { command: health.command, intervalSeconds: positive(health.interval_sec ?? 30, "healthcheck.interval_sec"),
      timeoutSeconds: positive(health.timeout_sec ?? 30, "healthcheck.timeout_sec"), retries, startPeriodSeconds: start,
      startIntervalSeconds: positive(health.start_interval_sec ?? 5, "healthcheck.start_interval_sec") };
    // Harbor Trial._prepare runs the TOML check for the agent environment only.
    // Separate verifiers start, receive artifacts, and run tests without this gate.
    // Keep validating the declaration even when that phase does not execute it.
    if (phase === "solve") spec.healthcheck = healthcheck;
  }
  return spec;
}

export async function loadGenericHarborTask(
  taskDir: string, datasetDir: string, id: string, config: HarborConfig, verifier: Verifier, signal: AbortSignal,
  phaseTimeouts: PhaseTimeoutOverrides = {}, hardware: HardwareKind = "npu",
): Promise<PreparedTask> {
  signal.throwIfAborted();
  const document = await readTomlDocument(await checkedPath(taskDir, "task.toml")).catch(error => {
    if (error instanceof TomlError) throw new HarborTaskError("TASK_DATA_INVALID", "Invalid task TOML", { cause: error });
    throw error;
  });
  fields(document, ["version", "schema_version", "task", "metadata", "environment", "verifier", "agent", "solution", "artifacts", "steps", "multi_step_reward_strategy", ...config.tasks.metadataFields], "task");
  if (document.schema_version !== undefined && (typeof document.schema_version !== "string" || !document.schema_version.trim())) invalid("schema_version must be a non-empty string");
  if (document.version !== undefined && document.version !== "1.0") unsupported(`Unsupported task version: ${String(document.version)}`);
  if (document.steps === undefined) return prepareHarborStage(taskDir, datasetDir, id, config, verifier, signal, phaseTimeouts, hardware, document);
  if (verifier.runtime) unsupported("Multi-step tasks currently require a shell verifier");
  if (!Array.isArray(document.steps) || !document.steps.length) invalid("steps must be a non-empty array");
  if (document.multi_step_reward_strategy !== undefined && !["mean", "final"].includes(String(document.multi_step_reward_strategy)))
    invalid("Invalid multi_step_reward_strategy");
  if (document.artifacts !== undefined && !Array.isArray(document.artifacts)) invalid("artifacts must be an array");
  const steps: PreparedStep[] = [];
  const names = new Set<string>();
  for (const value of document.steps) {
    const step = table(value, "step");
    fields(step, ["name", "agent", "verifier", "min_reward", "artifacts"], "step");
    if (typeof step.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(step.name) || names.has(step.name))
      invalid("Step names must be unique safe directory names");
    names.add(step.name);
    const stepDir = await checkedPath(taskDir, `steps/${step.name}`);
    const minReward = step.min_reward;
    if (step.artifacts !== undefined && !Array.isArray(step.artifacts)) invalid("step.artifacts must be an array");
    if (minReward !== undefined && !(typeof minReward === "number" && Number.isFinite(minReward)) &&
      !(minReward && typeof minReward === "object" && !Array.isArray(minReward) && Object.keys(minReward).length &&
        Object.values(minReward).every(value => typeof value === "number" && Number.isFinite(value)))) invalid("Invalid step.min_reward");
    const task = await prepareHarborStage(taskDir, datasetDir, id, config, verifier, signal, phaseTimeouts, hardware, {
      ...document,
      agent: { ...table(document.agent, "agent"), ...table(step.agent, "step.agent") },
      verifier: { ...table(document.verifier, "verifier"), ...table(step.verifier, "step.verifier"),
        env: { ...table(table(document.verifier, "verifier").env, "verifier.env"), ...table(table(step.verifier, "step.verifier").env, "step.verifier.env") } },
      artifacts: [...(Array.isArray(document.artifacts) ? document.artifacts : config.defaults.artifactPaths ?? []), ...(Array.isArray(step.artifacts) ? step.artifacts : [])],
    }, stepDir);
    const workdirFiles = (await lstat(join(stepDir, "workdir")).catch(() => null))?.isDirectory()
      ? await checkedPath(stepDir, "workdir") : undefined;
    const setupScript = workdirFiles && (await lstat(join(workdirFiles, "setup.sh")).catch(() => null))?.isFile();
    steps.push({ name: step.name, task,
      ...(minReward === undefined ? {} : { minReward: minReward as number | Record<string, number> }),
      ...(workdirFiles ? { workdirFiles, setupScript: setupScript === true } : {}) });
  }
  const first = steps[0]!;
  const verification = first.task.verification;
  if (!verification || typeof verification !== "object" || Array.isArray(verification)) invalid("Invalid step verification descriptor");
  return { ...first.task, steps,
    verification: { ...verification, stepRewardStrategy: document.multi_step_reward_strategy === "final" ? "final" : "mean" } };
}

async function prepareHarborStage(
  taskDir: string, datasetDir: string, id: string, config: HarborConfig, verifier: Verifier, signal: AbortSignal,
  phaseTimeouts: PhaseTimeoutOverrides, hardware: HardwareKind, document: Record<string, unknown>, stepDir?: string,
): Promise<PreparedTask> {
  const declaredEnvironment = table(document.environment, "environment");
  checkHardware(declaredEnvironment, hardware, `Task ${id} environment`);
  const declaredVerifier = table(document.verifier, "verifier");
  const agent = table(document.agent, "agent");
  fields(declaredVerifier, ["timeout_sec", "type", "environment_mode", "environment", "env", "collect", "network_mode", "allowed_hosts", "import_path", "user"], "verifier");
  fields(agent, ["timeout_sec", "network_mode", "allowed_hosts", "user"], "agent");
  const users = { solve: agent.user ?? config.defaults.agentUser, verify: declaredVerifier.user ?? config.defaults.verifierUser };
  for (const [phase, value] of Object.entries(users)) if (value !== undefined &&
    !(typeof value === "string" && /^[a-z_][a-z0-9_-]*$/u.test(value))) invalid(`Invalid ${phase} user`);
  if (declaredVerifier.type !== undefined && declaredVerifier.type !== "shell") unsupported("Unsupported verifier.type");
  const publicContext = join(taskDir, "environment");
  const composeServices = await readComposeServices(publicContext, "public", declaredImage(declaredEnvironment.docker_image, "environment.docker_image"), hardware, `Task ${id} environment`);
  const mainBuild = composeServices?.main?.build;
  const dockerfile = await readFile(mainBuild ? join(mainBuild.context, mainBuild.dockerfile) : join(publicContext, "Dockerfile"), "utf8").catch(error => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  const profile = config.taskProfiles?.[id];
  let inferredWorkdir;
  try { inferredWorkdir = profile?.workdir ?? declaredEnvironment.workdir ?? config.defaults.workdir ?? inferDockerWorkdir(dockerfile); }
  catch (cause) { throw new HarborTaskError("BENCHMARK_UNSUPPORTED", "Cannot infer task workdir; provide defaults.workdir or a task profile", { cause }); }
  const workdir = path(inferredWorkdir, "workdir");
  const solveEnv = await environment(declaredEnvironment, publicContext, workdir, "public", "solve", hardware, `Task ${id} environment`, composeServices);
  if (typeof users.solve === "string" || typeof users.verify === "string") solveEnv.executionUsers = {
    ...(typeof users.solve === "string" ? { solve: users.solve } : {}), ...(typeof users.verify === "string" ? { verify: users.verify } : {}) };
  const mcpServers = (declaredEnvironment.mcp_servers ?? []);
  if (!Array.isArray(mcpServers)) invalid("mcp_servers must be an array");
  const publicMcp: NonNullable<PublicTask["mcpServers"]> = mcpServers.map(value => {
    const server = table(value, "mcp_server");
    fields(server, ["name", "transport", "url"], "mcp_server");
    if (typeof server.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(server.name)) invalid("Invalid MCP server name");
    if (server.transport !== "sse" && server.transport !== "http") unsupported("Only HTTP and SSE MCP transports are supported");
    if (typeof server.url !== "string") invalid("Invalid MCP URL");
    let url: URL;
    try { url = new URL(server.url); } catch { return invalid("Invalid MCP URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) invalid("MCP URL must be credential-free HTTP(S)");
    const transport = server.transport;
    return { name: server.name, transport: transport === "sse" ? "sse" : "http", url: server.url };
  });
  if (new Set(publicMcp.map(server => server.name)).size !== publicMcp.length) invalid("Duplicate MCP server names");
  const solveNetwork = phaseNetwork(agent, declaredEnvironment);
  solveEnv.network = solveNetwork === "none" ? "model-api" : solveNetwork;
  const mode = declaredVerifier.environment_mode ?? (declaredVerifier.environment === undefined ? "shared" : "separate");
  if (mode !== "shared" && mode !== "separate") invalid("verifier.environment_mode must be shared or separate");
  if (mode === "shared" && declaredVerifier.environment !== undefined) invalid("Shared verifier cannot declare a separate environment");
  if (mode === "shared") solveEnv.sharedLogs = true;
  const taskVerifyTimeout = declaredVerifier.timeout_sec === undefined ? undefined : positive(declaredVerifier.timeout_sec, "verifier.timeout_sec");
  const taskSolveTimeout = agent.timeout_sec === undefined ? undefined : positive(agent.timeout_sec, "agent.timeout_sec");
  const multiplier = config.defaults.timeoutMultiplier ?? 1;
  const timeoutSeconds = phaseTimeouts.verifyTimeoutSeconds ?? (taskVerifyTimeout === undefined ? undefined : taskVerifyTimeout * multiplier);
  const solveTimeoutSeconds = phaseTimeouts.solveTimeoutSeconds ?? (taskSolveTimeout === undefined ? undefined : taskSolveTimeout * multiplier);
  let verifyEnv: EnvironmentSpec | null = null;
  let testsInImage = false;
  if (mode === "separate") {
    const overrides = table(declaredVerifier.environment, "verifier.environment");
    checkHardware(overrides, hardware, `Task ${id} verifier.environment`);
    const context = join(stepDir ?? taskDir, "tests");
    const services = await readComposeServices(context, "verifier", declaredImage(overrides.docker_image, "verifier.environment.docker_image"), hardware, `Task ${id} verifier.environment`);
    const dockerfile = await lstat(join(context, "Dockerfile")).catch(() => null);
    testsInImage = overrides.docker_image !== undefined || dockerfile?.isFile() === true ||
      services?.main?.build !== undefined || typeof services?.main?.image === "string";
    const declaration = { ...overrides };
    // Inherit resource limits without carrying the agent image, healthcheck,
    // skills or MCP configuration into a dedicated grading environment.
    for (const key of ["cpus", "platform", "os", "build_timeout_sec"])
      if (declaration[key] === undefined && declaredEnvironment[key] !== undefined) declaration[key] = declaredEnvironment[key];
    for (const key of ["memory", "storage"])
      if (declaration[key] === undefined && declaration[`${key}_mb`] === undefined)
        for (const field of [key, `${key}_mb`])
          if (declaredEnvironment[field] !== undefined) declaration[field] = declaredEnvironment[field];
    const verifyWorkdir = path(overrides.workdir ?? workdir, "verifier.environment.workdir");
    if (testsInImage) verifyEnv = await environment(declaration, context, verifyWorkdir, "verifier", "verify", hardware, `Task ${id} verifier.environment`, services);
    else {
      const fallback = { ...declaredEnvironment, ...declaration };
      for (const key of ["memory", "storage"]) {
        if (overrides[key] !== undefined) delete fallback[`${key}_mb`];
        if (overrides[`${key}_mb`] !== undefined) delete fallback[key];
      }
      verifyEnv = await environment(fallback, publicContext, verifyWorkdir, "public", "verify", hardware, `Task ${id} verifier.environment`, composeServices);
    }
    verifyEnv.network = phaseNetwork(declaredVerifier, table(declaredVerifier.environment ?? declaredEnvironment, "verifier.environment"));
    if (typeof users.verify === "string") verifyEnv.executionUsers = { verify: users.verify };
  }
  const hooks = document.verifier && declaredVerifier.collect !== undefined ? declaredVerifier.collect : [];
  if (!Array.isArray(hooks)) invalid("verifier.collect must be an array");
  const collect = (hooks as unknown[]).map(value => {
    const hook = table(value, "verifier.collect");
    fields(hook, ["command", "timeout_sec", "service"], "verifier.collect");
    if (hook.service !== undefined && (typeof hook.service !== "string" || (hook.service !== "main" && !solveEnv.services?.[hook.service]))) invalid("Unknown collect service");
    if (typeof hook.command !== "string" || !hook.command.trim()) invalid("Collect command must be non-empty");
    // Harbor keeps bash in main, but third-party sidecars may provide only sh.
    return { executable: hook.service && hook.service !== "main" ? "sh" : "bash", args: ["-c", hook.command as string], cwd: workdir, env: {},
      timeoutSeconds: positive(hook.timeout_sec ?? 60, "collect.timeout_sec"),
      ...(typeof hook.service === "string" ? { service: hook.service } : {}) };
  });
  const artifacts = document.artifacts ?? config.defaults.artifactPaths ?? [];
  if (!Array.isArray(artifacts)) invalid("artifacts must be an array");
  const excludes: Record<string, string[]> = {};
  const artifactServices: Record<string, string> = {};
  const explicit = [...(artifacts as unknown[]).map(value => {
    if (typeof value === "string") return path(value, "artifacts");
    const artifact = table(value, "artifact");
    fields(artifact, ["source", "exclude", "service", "destination"], "artifact");
    if (artifact.service !== undefined && (typeof artifact.service !== "string" || (artifact.service !== "main" && !solveEnv.services?.[artifact.service]))) invalid("Unknown artifact service");
    if (artifact.destination !== undefined) unsupported("Artifact destination remapping is unsupported");
    const source = path(artifact.source, "artifact.source");
    if (typeof artifact.service === "string" && artifact.service !== "main") artifactServices[source] = artifact.service;
    if (artifact.exclude !== undefined) {
      if (!Array.isArray(artifact.exclude) || artifact.exclude.some(item => typeof item !== "string" || !item.trim() || /[\0\r\n]/u.test(item))) invalid("Invalid artifact exclusion patterns");
      if (artifact.exclude.length) excludes[source] = artifact.exclude as string[];
    }
    return source;
  }), ...(document.artifacts !== undefined && artifacts.length === 0 ? [] : profile?.extraPaths ?? [])];
  if (new Set(explicit).size !== explicit.length) invalid("Duplicate artifact sources");
  if (explicit.some(item => explicit.some(parent => item !== parent && item.startsWith(`${parent}/`))))
    unsupported("Overlapping artifact paths are unsupported; declare non-overlapping files or directories");
  // Harbor collects declared outputs best-effort. A missing deliverable must
  // reach the official verifier, which decides its reward.
  const artifactSpec = explicit.length ? { kind: "artifacts" as const, workdir, paths: explicit, optionalPaths: [...explicit],
    ...(Object.keys(artifactServices).length ? { services: artifactServices } : {}),
    ...(Object.keys(excludes).length ? { excludes } : {}) } : null;
  const importPath = declaredVerifier.import_path;
  if (importPath !== undefined && (typeof importPath !== "string" || !/^[\w.]+:[A-Za-z_]\w*$/u.test(importPath)))
    invalid("Invalid verifier.import_path");
  const descriptor = await verifier.prepare({ id, taskDir, ...(stepDir ? { stepName: posix.basename(stepDir.replaceAll("\\", "/")) } : {}), datasetDir, workdir, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(typeof importPath === "string" ? { importPath } : {}) }, signal);
  const verification = { descriptor, env: environmentVariables(declaredVerifier.env, "verifier.env"),
    ...(testsInImage ? { testsInImage: true } : {}) };
  return { input: { id, prompt: await readPublicInstruction(stepDir ?? taskDir, () => new HarborTaskError("TASK_DATA_INVALID", "Empty instruction.md")),
    ...(typeof declaredEnvironment.skills_dir === "string" ? { skillsDirectories: [declaredEnvironment.skills_dir] } : {}),
    ...(publicMcp.length ? { mcpServers: publicMcp } : {}) },
    solveEnv, verifyEnv, verification, verificationMode: mode,
    ...(config.defaults.scoreAfterSolveFailure === undefined ? {} : { scoreAfterSolveFailure: config.defaults.scoreAfterSolveFailure }),
    ...(mode === "shared" ? { verificationNetwork: phaseNetwork(declaredVerifier, declaredEnvironment) } : {}),
    transfer: mode === "shared" ? null : artifactSpec,
    ...(mode === "shared" && artifactSpec ? { artifactCollection: artifactSpec } : {}),
    ...(collect.length ? { collect } : {}),
    preparationTimeoutSeconds: { solve: positive(declaredEnvironment.build_timeout_sec ?? config.defaults.buildTimeoutSeconds, "environment.build_timeout_sec"),
      verify: positive(table(declaredVerifier.environment, "verifier.environment").build_timeout_sec ?? config.defaults.buildTimeoutSeconds, "verifier.environment.build_timeout_sec") },
    phaseTimeoutSeconds: {
      ...(timeoutSeconds === undefined ? {} : { verify: timeoutSeconds }), ...(solveTimeoutSeconds === undefined ? {} : { solve: solveTimeoutSeconds }) } };
}
