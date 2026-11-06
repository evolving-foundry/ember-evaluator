import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { DockerCommand } from "./runtime-contract.js";
import type { ImageCleanupRequest, ImageCleanupNode, ImageCleanupItem } from "../../core/contracts/image-cleanup.js";
import { acquireRuntimeLock } from "../runtime-installation/lock.js";
import { applicationCacheRoot } from "../runtime-installation/install.js";

type Owner = { configFingerprint: string; taskId: string; phase: string };
type Entry = { reference: string; id: string; owned: boolean; owners: Owner[]; dependencies: string[] };
type Lease = { token: string; pid: number; host: string };
type Inventory = { schemaVersion: 1; daemonId: string; inventoryId: string; entries: Entry[]; leases: Lease[] };
type Scope = { owner?: Owner; touched: Set<string>; seen: Set<string>; lease?: Promise<() => Promise<void>> };
const namespace = "ember-evaluator/";
const digest = /^sha256:[a-f0-9]{64}$/u;
const absent = (error: unknown) => error instanceof Error && /no such (?:image|object)|not found/iu.test(error.message);

/** Persist references, rather than deleting image IDs which may have foreign aliases. */
export class DockerImageInventory {
  private readonly scope = new AsyncLocalStorage<Scope>();
  private identity: Promise<{ id: string; path: string }> | undefined;
  constructor(private readonly raw: DockerCommand, private readonly root = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "docker-images")) {}

  private location(signal: AbortSignal) {
    return this.identity ??= (async () => {
      const id = (await this.raw(["info", "--format", "{{.ID}}"], { signal })).stdout.trim();
      if (!id || /[\u0000-\u001f]/u.test(id)) throw new Error("Docker daemon identity is unavailable");
      return { id, path: join(this.root, createHash("sha256").update(id).digest("hex") + ".json") };
    })();
  }
  private async read(path: string, daemonId: string): Promise<{ data: Inventory; missing: boolean }> {
    let data: unknown;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe image inventory file");
      data = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {
        data: { schemaVersion: 1, daemonId, inventoryId: randomUUID(), entries: [], leases: [] }, missing: true,
      };
      throw error;
    }
    if (!data || typeof data !== "object" || !("schemaVersion" in data) || data.schemaVersion !== 1 || !("daemonId" in data) || data.daemonId !== daemonId ||
      !("inventoryId" in data) || typeof data.inventoryId !== "string" || !data.inventoryId ||
      !("entries" in data) || !Array.isArray(data.entries) || !("leases" in data) || !Array.isArray(data.leases)) throw new Error("Invalid image inventory");
    for (const entry of data.entries) {
      if (!entry || typeof entry.reference !== "string" || !entry.reference || /[\s\u0000-\u001f]/u.test(entry.reference) || entry.reference.startsWith("-") ||
        typeof entry.id !== "string" || !digest.test(entry.id) || typeof entry.owned !== "boolean" || !Array.isArray(entry.owners) ||
        !entry.owners.every((owner: unknown) => validOwner(owner)) || !Array.isArray(entry.dependencies) || !entry.dependencies.every((id: unknown) => typeof id === "string" && digest.test(id))) throw new Error("Invalid image inventory entry");
    }
    for (const lease of data.leases) if (!lease || typeof lease.token !== "string" || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || typeof lease.host !== "string") throw new Error("Invalid image inventory lease");
    return { data: data as Inventory, missing: false };
  }
  private async save(path: string, data: Inventory) {
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(data) + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
  }
  private async edit<T>(signal: AbortSignal, action: (data: Inventory) => Promise<T> | T, save = true): Promise<T> {
    const { id, path } = await this.location(signal);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const release = await acquireRuntimeLock(`${path}.lock`, signal);
    try {
      const { data, missing } = await this.read(path, id);
      // An empty identity receipt lets nodes on a shared cache recognize the
      // same daemon during their first preview, without recording associations.
      if (missing && !save) await this.save(path, data);
      const result = await action(data);
      if (save) await this.save(path, data);
      return result;
    } finally { await release(); }
  }
  async lease(signal: AbortSignal): Promise<() => Promise<void>> {
    const token = randomUUID();
    await this.edit(signal, data => { data.leases.push({ token, pid: process.pid, host: hostname() }); });
    let released = false;
    return async () => {
      if (released) return;
      await this.edit(AbortSignal.timeout(10_000), data => { data.leases = data.leases.filter(lease => lease.token !== token); });
      released = true;
    };
  }
  async use<T>(owner: Owner | undefined, signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    const held = await this.hold(owner, signal, action);
    try { return held.value; } finally { await held.release(); }
  }
  async hold<T>(owner: Owner | undefined, signal: AbortSignal, action: () => Promise<T>) {
    signal.throwIfAborted();
    const scope: Scope = { ...(owner ? { owner } : {}), touched: new Set(), seen: new Set() };
    const release = async () => { if (scope.lease) await (await scope.lease)(); };
    try { return { value: await this.scope.run(scope, action), release }; }
    catch (error) { await release(); throw error; }
  }
  private async inspect(reference: string, signal: AbortSignal): Promise<{ id: string; tags: string[]; digests: string[] } | undefined> {
    try {
      const raw = JSON.parse((await this.raw(["image", "inspect", reference, "--format", "[{{json .Id}},{{json .RepoTags}},{{json .RepoDigests}}]"], { signal })).stdout) as unknown;
      if (!Array.isArray(raw) || typeof raw[0] !== "string" || !digest.test(raw[0]) || ![raw[1], raw[2]].every(value => value === null || Array.isArray(value) && value.every(item => typeof item === "string"))) throw new Error("Invalid Docker image inventory response");
      return { id: raw[0], tags: raw[1] ?? [], digests: raw[2] ?? [] };
    } catch (error) { signal.throwIfAborted(); if (absent(error)) return undefined; throw error; }
  }
  private async observe(reference: string, signal: AbortSignal, acquired = false, dependencies?: string[]) {
    const scope = this.scope.getStore();
    if (!scope) return;
    if (!acquired && !dependencies && (scope.seen.has(reference) || digest.test(reference) && scope.touched.has(reference))) return;
    const image = await this.inspect(reference, signal);
    if (!image) return;
    await this.edit(signal, data => {
      let entry = data.entries.find(entry => entry.reference === reference);
      if (entry && entry.id !== image.id) {
        // A moved external tag is never evidence that its new content is ours.
        entry.id = image.id; entry.owned = acquired || reference.startsWith(namespace); entry.owners = []; entry.dependencies = [];
      }
      if (!entry && !digest.test(reference)) { entry = { reference, id: image.id, owned: acquired || reference.startsWith(namespace), owners: [], dependencies: [] }; data.entries.push(entry); }
      if (entry) {
        entry.owned ||= acquired;
        if (dependencies) entry.dependencies = [...new Set(dependencies)].filter(id => id !== image.id);
      }
      const owner = scope.owner;
      const associate = (record: Entry) => {
        if (owner && !record.owners.some(value => sameOwner(value, owner))) record.owners.push(owner);
      };
      if (entry) associate(entry);
      const ids = new Set([image.id, ...(entry?.dependencies ?? [])]);
      // Include dependencies even when runtime and solver caches bypass Docker.
      let changed = true;
      while (changed) {
        changed = false;
        for (const record of data.entries) if (ids.has(record.id)) {
          associate(record);
          for (const id of record.dependencies) if (!ids.has(id)) { ids.add(id); changed = true; }
        }
      }
    });
    scope.touched.add(image.id);
    scope.seen.add(reference);
  }
  readonly command: DockerCommand = async (args, options) => {
    const scope = this.scope.getStore();
    if (!scope || args[0] === "info" || args[0] === "version") return this.raw(args, options);
    const signal = options?.signal ?? AbortSignal.timeout(60_000);
    scope.lease ??= this.lease(signal);
    await scope.lease;
    const pull = args[0] === "pull" ? args.at(-1) : undefined;
    let absentBeforePull = false;
    if (pull) {
      try { absentBeforePull = await this.inspect(pull, signal) === undefined; }
      catch { signal.throwIfAborted(); /* Unknown prior ownership never authorizes source deletion. */ }
    }
    const result = await this.raw(args, options);
    const tagIndex = args.indexOf("--tag");
    const reference = pull ?? (args[0] === "build" && tagIndex >= 0 ? args[tagIndex + 1] :
      args[0] === "image" && args[1] === "tag" ? args[3] : undefined);
    if (reference) await this.observe(reference, signal, Boolean(pull && absentBeforePull), args[0] === "build" ? await this.buildDependencies(args, signal) : undefined);
    else if (args[0] === "image" && args[1] === "inspect") {
      const end = args.indexOf("--format");
      const refs = args.slice(2, end < 0 ? undefined : end).filter((arg, index, values) => !arg.startsWith("--") && values[index - 1] !== "--platform");
      for (const ref of refs) await this.observe(ref, signal);
    }
    return result;
  };

  private async buildDependencies(args: string[], signal: AbortSignal): Promise<string[]> {
    const argsByName = new Map<string, string>();
    for (let index = 0; index < args.length; index++) if (args[index] === "--build-arg") {
      const value = args[index + 1] ?? "", separator = value.indexOf("=");
      if (separator > 0) argsByName.set(value.slice(0, separator), value.slice(separator + 1));
    }
    const fileIndex = Math.max(args.indexOf("--file"), args.indexOf("-f"));
    const file = fileIndex < 0 ? join(args.at(-1)!, "Dockerfile") : args[fileIndex + 1]!;
    const dockerfile = await readFile(file, "utf8");
    const stages = new Set<string>(), dependencies: string[] = [];
    for (const line of dockerfile.split(/\r?\n/u)) {
      const argument = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/iu.exec(line);
      if (argument && !argsByName.has(argument[1]!)) argsByName.set(argument[1]!, argument[2]!.trim());
      const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/iu.exec(line);
      if (!match) continue;
      const image = match[1]!.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, first: string, second: string) => argsByName.get(first ?? second) ?? "");
      if (image && !image.includes("$") && image !== "scratch" && !stages.has(image.toLowerCase())) {
        const found = await this.inspect(image, signal);
        if (found) dependencies.push(found.id);
      }
      if (match[2]) stages.add(match[2].toLowerCase());
    }
    return dependencies;
  }
  async associatePrepared(value: unknown, signal: AbortSignal): Promise<void> {
    if (typeof value === "string" && (value.startsWith(namespace) || digest.test(value))) await this.observe(value, signal);
    else if (Array.isArray(value)) for (const item of value) await this.associatePrepared(item, signal);
    else if (value && typeof value === "object") for (const item of Object.values(value)) await this.associatePrepared(item, signal);
  }

  async cleanup(request: ImageCleanupRequest, signal: AbortSignal): Promise<ImageCleanupNode> {
    if (!request.all && !request.configFingerprint) throw new TypeError("Image cleanup requires a configuration or --all");
    const callerSignal = signal;
    const deadline = AbortSignal.timeout(600_000);
    signal = AbortSignal.any([signal, deadline]);
    const commandSignal = () => AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const command = (args: string[]) => this.raw(args, { signal: commandSignal() });
    const { id } = await this.location(signal);
    return this.edit(signal, async data => {
      const items: ImageCleanupItem[] = [];
      const leases = data.leases.filter(lease => {
        if (lease.host !== hostname()) return true;
        try { process.kill(lease.pid, 0); return true; }
        catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
      });
      const inventory = request.all ? (await command(["image", "ls", "--no-trunc", "--format", "{{json .}}"])).stdout.trim() : "";
      const listedImages = new Map<string, string | null>();
      if (request.all) for (const line of inventory.split(/\r?\n/u).filter(Boolean)) {
        const image: unknown = JSON.parse(line);
        if (!image || typeof image !== "object" || !("Repository" in image) || typeof image.Repository !== "string" || !("Tag" in image) || typeof image.Tag !== "string") throw new Error("Invalid Docker image list");
        if (image.Tag === "<none>") continue;
        const reference = `${image.Repository}:${image.Tag}`;
        const listedId = "ID" in image && typeof image.ID === "string" && digest.test(image.ID) ? image.ID : undefined;
        listedImages.set(reference, listedId ?? null);
        if (!image.Repository.startsWith(namespace)) continue;
        if (!data.entries.some(entry => entry.reference === reference)) {
          const found = listedId ? { id: listedId } : await this.inspect(reference, commandSignal());
          if (found) data.entries.push({ reference, id: found.id, owned: true, owners: [], dependencies: [] });
        }
      }
      const selected = data.entries.filter(entry => request.all || entry.owners.some(owner => owner.configFingerprint === request.configFingerprint));
      // A lease already forbids every deletion. Do not hold up its release
      // while inspecting containers which cannot change this decision.
      const containers = leases.length ? [] : (await command(["ps", "--all", "--quiet", "--no-trunc"])).stdout.trim().split(/\s+/u).filter(Boolean);
      const used = new Set<string>();
      for (const container of containers) {
        if (!/^[a-f0-9]{12,64}$/u.test(container)) throw new Error("Invalid Docker container identity");
        used.add((await command(["container", "inspect", container, "--format", "{{.Image}}"])).stdout.trim());
      }
      const remainingOwners = (entry: Entry) => entry.owners.filter(owner => owner.configFingerprint !== request.configFingerprint);
      const retainedIds = new Set(selected.filter(entry => !request.all && remainingOwners(entry).length).map(entry => entry.id));
      // Remove derived images before their inputs. Aliases can have the same ID.
      const ordered: Entry[] = [], pending = [...selected];
      while (pending.length) {
        const index = pending.findIndex(entry => !pending.some(other => other.id !== entry.id && other.dependencies.includes(entry.id)));
        ordered.push(pending.splice(index < 0 ? 0 : index, 1)[0]!);
      }
      for (const entry of ordered) {
        const add = (status: ImageCleanupItem["status"], reason: string) => items.push({ reference: entry.reference, imageId: entry.id, status, reason });
        if (signal.aborted) { add("skipped", "Cleanup cancelled before this reference was processed"); continue; }
        if (leases.length) { add("skipped", "Docker images are in use by evaluation or preparation"); continue; }
        if (!entry.owned) {
          if (request.execute) entry.owners = request.all ? [] : remainingOwners(entry);
          add("retained", "Source reference existed before evaluator acquisition"); continue;
        }
        if (used.has(entry.id)) { add("skipped", "Referenced by a running or stopped container"); continue; }
        if (retainedIds.has(entry.id)) {
          if (request.execute) entry.owners = remainingOwners(entry);
          add("retained", "Still associated with another configuration or task"); continue;
        }
        try {
          const listedId = listedImages.get(entry.reference);
          const snapshotPreview = request.all && !request.execute && !entry.reference.includes("@") &&
            entry.reference.lastIndexOf(":") > entry.reference.lastIndexOf("/") && listedId !== null;
          // A preview is a snapshot; removing images still rechecks each exact
          // reference immediately before its delete command.
          const current = snapshotPreview ? listedId ? { id: listedId, tags: [] } : undefined
            : await this.inspect(entry.reference, commandSignal());
          if (!current) { if (request.execute) data.entries = data.entries.filter(item => item !== entry); add("skipped", "Reference is already absent"); continue; }
          if (current.id !== entry.id) { add("skipped", "Image reference changed since it was recorded"); continue; }
          if (entry.reference.includes("@") && current.tags.some(reference => !data.entries.some(record => record.reference === reference && record.id === entry.id && record.owned))) {
            add("retained", "Digest also has image tags outside evaluator ownership"); continue;
          }
          if (!request.execute) { add("candidate", "Eligible evaluator image reference"); continue; }
          await command(["image", "rm", "--no-prune", entry.reference]);
          data.entries = data.entries.filter(item => item !== entry);
          add("deleted", "Removed evaluator image reference");
        } catch { add("failed", signal.aborted ? "Cleanup interrupted; removal was not confirmed" : "Docker could not remove or verify the image reference"); }
      }
      if (request.execute) data.leases = leases;
      return { nodeId: hostname(), daemonId: id, inventoryId: data.inventoryId, items,
        ...(deadline.aborted && !callerSignal.aborted ? { error: "Image cleanup deadline exceeded" } : {}) };
    }, request.execute);
  }
}

function validOwner(value: unknown): value is Owner {
  return Boolean(value && typeof value === "object" && "configFingerprint" in value && typeof value.configFingerprint === "string" &&
    "taskId" in value && typeof value.taskId === "string" && "phase" in value && typeof value.phase === "string");
}
function sameOwner(left: Owner, right: Owner) {
  return left.configFingerprint === right.configFingerprint && left.taskId === right.taskId && left.phase === right.phase;
}
