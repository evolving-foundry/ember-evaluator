import { createHash } from "node:crypto";
import { mkdir, writeFile, mkdtemp, rm, lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { tmpdir } from "node:os";
import type { EnvironmentSpec, CommandSpec, ProcessHandle, TransferSpec } from "../../core/contracts/environment.js";
import type { AttemptKey, AttemptPaths } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import type { DockerCommand } from "./runtime-contract.js";
import { EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER } from "./runtime-contract.js";
import { buildFileManifest } from "../../core/artifacts/artifacts.js";
import { startLocalProcess, runtimeProcessEnvironment } from "../process/local.js";
import { ComposeEntrypoint } from "./compose-entrypoint.js";

export function composeEnvironment(value: JsonValue | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (Array.isArray(value)) return Object.fromEntries(value.map(item => {
    if (typeof item !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*=/u.test(item)) throw new Error("Compose environment must provide explicit values");
    const index = item.indexOf("=");
    return [item.slice(0, index), item.slice(index + 1)];
  }));
  if (!value || typeof value !== "object") throw new Error("Invalid Compose environment");
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean"))
      throw new Error("Compose environment must provide explicit scalar values");
    return [key, String(item)];
  }));
}

function composeHosts(value: JsonValue | undefined): Record<string, JsonValue> {
  if (value === undefined) return {};
  if (Array.isArray(value)) return Object.fromEntries(value.map(host => {
    if (typeof host !== "string" || !host.includes(":")) throw new Error("Invalid Compose extra_hosts");
    const index = host.indexOf(":"); return [host.slice(0, index), host.slice(index + 1)];
  }));
  if (!value || typeof value !== "object") throw new Error("Invalid Compose extra_hosts");
  return { ...value };
}

/** Docker shares the owner's hosts file with container/service network mode. */
export function relocateSharedNetworkHosts(services: Record<string, Record<string, JsonValue>>): void {
  for (const [name, service] of Object.entries(services)) {
    if (typeof service.network_mode !== "string" || !service.network_mode.startsWith("service:")) continue;
    const hosts = composeHosts(service.extra_hosts);
    const visited = new Set([name]);
    let owner = service;
    while (typeof owner.network_mode === "string" && owner.network_mode.startsWith("service:")) {
      const target = owner.network_mode.slice("service:".length);
      if (visited.has(target)) throw new Error(`Compose network namespace cycle at ${target}`);
      visited.add(target);
      const next = services[target];
      if (!next) throw new Error(`Unknown Compose network owner ${target}`);
      owner = next;
    }
    const merged = composeHosts(owner.extra_hosts);
    for (const [host, address] of Object.entries(hosts)) {
      if (merged[host] !== undefined && merged[host] !== address) throw new Error(`Conflicting Compose host mapping for ${host}`);
      merged[host] = address;
    }
    if (Object.keys(merged).length) owner.extra_hosts = merged;
    delete service.extra_hosts;
  }
}

/** Owns only one attempt's services and network. No global compose project or prune. */
export class DockerComposeProject {
  readonly name: string;
  private readonly file: string;
  private readonly emptyEnv: string;
  private readonly containers = new Map<string, string>();
  private disposal: Promise<void> | undefined;
  private readonly entrypoint: ComposeEntrypoint;
  get identities(): Record<string, string> { return Object.fromEntries(this.containers); }
  constructor(private readonly command: DockerCommand, private readonly executable: string,
    private readonly spec: EnvironmentSpec, private readonly paths: AttemptPaths,
    key: AttemptKey, private readonly phase: "solve" | "verify") {
    this.name = "ember-" + createHash("sha256").update(JSON.stringify({ key, phase })).digest("hex").slice(0, 24);
    this.file = join(paths.root, `compose-${phase}.json`);
    this.emptyEnv = join(paths.root, `compose-${phase}.env`);
    this.entrypoint = new ComposeEntrypoint(paths.root, phase);
  }
  private args(args: string[]): string[] {
    return ["compose", "--project-name", this.name, "--env-file", this.emptyEnv, "--file", this.file, ...args];
  }
  async create(main: Record<string, JsonValue>, images: Record<string, string>, labels: Record<string, string>, signal: AbortSignal): Promise<string> {
    const services: Record<string, Record<string, JsonValue>> = {};
    for (const [name, service] of Object.entries(this.spec.services ?? {})) {
      if (name === "main") continue;
      const image = images[name];
      if (!image) throw new Error(`Missing prepared image for service ${name}`);
      services[name] = { ...service.properties, environment: composeEnvironment(service.properties.environment), image,
        platform: main.platform ?? "linux/amd64", labels, restart: "no" };
    }
    const properties = this.spec.services?.main?.properties ?? {};
    const hosts = composeHosts(properties.extra_hosts);
    hosts["host.docker.internal"] = "host-gateway";
    services.main = { ...properties, ...main,
      ...(properties.command === undefined || properties.command === null ? {} : { command: properties.command }),
      extra_hosts: hosts,
      environment: { ...composeEnvironment(properties.environment), ...composeEnvironment(main.environment) } };
    relocateSharedNetworkHosts(services);
    const volumes = Object.fromEntries((Array.isArray(main.volumes) ? main.volumes : []).flatMap(mount =>
      mount && typeof mount === "object" && !Array.isArray(mount) && mount.type === "volume" && typeof mount.source === "string"
        ? [[mount.source, { external: true }]] : []));
    const document = { services, networks: { default: { labels } }, ...(Object.keys(volumes).length ? { volumes } : {}) };
    // Never interpolate coordinator credentials into dataset-authored strings.
    if (/\$\{/u.test(JSON.stringify(document))) throw new Error("Compose variable interpolation is unsupported");
    await mkdir(this.paths.root, { recursive: true });
    await writeFile(this.emptyEnv, "", { mode: 0o600 });
    await writeFile(this.file, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
    try {
      // Compose owns shell-form parsing; keep quoted arguments and explicit
      // empty entrypoint/command overrides consistent with its syntax.
      if (typeof services.main.entrypoint === "string" || typeof services.main.command === "string") {
        const normalized: unknown = JSON.parse((await this.command(this.args(["config", "--format", "json"]), { signal })).stdout);
        if (!normalized || typeof normalized !== "object" || !("services" in normalized) || !normalized.services ||
            typeof normalized.services !== "object" || !("main" in normalized.services) || !normalized.services.main ||
            typeof normalized.services.main !== "object")
          throw new Error("Compose did not normalize the main startup");
        for (const field of ["entrypoint", "command"] as const) {
          if (typeof services.main[field] !== "string") continue;
          const value = Reflect.get(normalized.services.main, field);
          if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`Invalid normalized main ${field}`);
          services.main[field] = value;
        }
      }
      await this.entrypoint.configure(services.main, this.command, signal);
      await writeFile(this.file, JSON.stringify(document, null, 2) + "\n", { mode: 0o600 });
      await this.command(this.args(["up", "--detach", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "1200"]), { signal, maxBuffer: 16 * 1024 * 1024 });
      for (const name of Object.keys(services)) {
        const id = (await this.command(this.args(["ps", "--all", "--quiet", name]), { signal })).stdout.trim();
        if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error(`Invalid container identity for ${name}`);
        this.containers.set(name, id);
      }
      const id = this.containers.get("main");
      if (!id) throw new Error("Compose did not create main");
      return id;
    } catch (cause) {
      let cleanup: unknown;
      try { await this.dispose(AbortSignal.timeout(30_000)); } catch (error) { cleanup = error; }
      throw new Error(`Task service project ${this.name} could not start: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause: cleanup === undefined ? cause : new AggregateError([cause, cleanup], "Service startup and cleanup failed") });
    }
  }
  async enterMaintenance(signal: AbortSignal): Promise<void> {
    await this.entrypoint.enterMaintenance(signal);
  }
  async start(service: string, command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> {
    const id = this.containers.get(service);
    if (!id || service === "main") throw new Error(`Unknown sidecar service: ${service}`);
    return startLocalProcess({ executable: this.executable,
      args: ["exec", "--interactive", ...Object.entries(command.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        id, command.executable, ...command.args], cwd: this.paths.root, env: runtimeProcessEnvironment(), inheritEnv: false, input: command.input }, signal);
  }
  async snapshotArtifacts(mainId: string, spec: Extract<TransferSpec, { kind: "artifacts" }>, signal: AbortSignal): Promise<void> {
    for (const [source, service] of Object.entries(spec.services ?? {})) {
      const id = this.containers.get(service);
      if (!id || service === "main") throw new Error(`Unknown artifact service: ${service}`);
      const stage = await mkdtemp(join(tmpdir(), "ember-service-artifact-"));
      const payload = join(stage, "payload");
      try {
        await this.command(["cp", `${id}:${source}`, payload], { signal });
        const stat = await lstat(payload);
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("Unsafe sidecar artifact");
        if (stat.isDirectory() && (await buildFileManifest(payload, [])).missing.length) throw new Error("Unsafe sidecar artifact tree");
        await this.command(["exec", mainId, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "mkdir", "/", source, "file"], { signal });
        await this.command(["exec", mainId, EVALUATOR_NODE_EXECUTABLE, "-e", "require('node:fs').rmSync(process.argv[1],{recursive:true,force:true})", source], { signal });
        await this.command(["cp", payload, `${mainId}:${posix.normalize(source)}`], { signal });
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
  }
  dispose(signal: AbortSignal): Promise<void> {
    this.disposal ??= this.cleanup(signal);
    return this.disposal;
  }
  private async cleanup(signal: AbortSignal): Promise<void> {
    try {
      const logs = await this.command(this.args(["logs", "--no-color", "--tail", "100"]), { signal, maxBuffer: 8 * 1024 * 1024 });
      await writeFile(join(this.paths.root, `compose-${this.phase}.log`), logs.stdout + logs.stderr);
    } finally {
      await this.command(this.args(["down", "--volumes", "--remove-orphans", "--timeout", "2"]), { signal });
    }
  }
}

export async function recoverComposeNetworks(command: DockerCommand, keys: AttemptKey[], signal: AbortSignal): Promise<void> {
  for (const key of keys) {
    const expected = Object.fromEntries(Object.entries({ "ember.run": key.runId, "ember.task": key.taskId, "ember.attempt": key.attemptId })
      .map(([name, value]) => [name, value.replace(/[\u0000-\u001f\u007f]/gu, "_")]));
    const output = await command(["network", "ls", "--quiet", ...Object.entries(expected).flatMap(([name, value]) => ["--filter", `label=${name}=${value}`])], { signal });
    for (const id of output.stdout.trim().split(/\s+/u).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error("Invalid task network identity");
      const networks: unknown = JSON.parse((await command(["network", "inspect", id], { signal })).stdout);
      if (!Array.isArray(networks) || networks.length !== 1) throw new Error("Invalid task network inventory");
      const network: unknown = networks[0];
      if (!network || typeof network !== "object" || !("Labels" in network) || !network.Labels || typeof network.Labels !== "object")
        throw new Error("Task network has no ownership labels");
      const labels = network.Labels;
      if (Object.entries(expected).some(([name, value]) => !(name in labels) || Reflect.get(labels, name) !== value))
        throw new Error("Task network ownership changed");
      await command(["network", "rm", id], { signal });
    }
  }
}
