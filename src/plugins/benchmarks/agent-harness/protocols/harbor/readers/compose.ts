import type { HardwareKind } from "../../../../../../core/contracts/hardware.js";
import { gpuRequirementMessage } from "../../../../../../core/policies/hardware.js";
import type { ErrorCode } from "../../../../../../core/errors/registry.js";
import { readFile, lstat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { parse } from "yaml";
import type { ContainerService, EnvironmentSpec } from "../../../../../../core/contracts/environment.js";
import type { JsonValue } from "../../../../../../core/contracts/task.js";
import { assertJsonValue } from "../../../../../../core/validation/input.js";
import { buildFileManifest, checkedPath } from "../../../../../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../../../../../core/results/run-manifest.js";

export class ComposeCapabilityError extends Error {
  readonly code: ErrorCode = "BENCHMARK_UNSUPPORTED";
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ComposeCapabilityError(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ComposeCapabilityError(`Unsupported ${label}.${key}`);
}
function inside(root: string, requested: string): string {
  const path = resolve(root, requested);
  const offset = relative(root, path);
  if (offset === ".." || offset.startsWith("../") || offset.startsWith("..\\") || isAbsolute(offset))
    throw new ComposeCapabilityError("Compose build path escapes the public environment");
  return path;
}
export async function readComposeServices(context: string, visibility: "public" | "verifier", mainImage?: string,
  hardware: HardwareKind = "npu", requirement = "Compose environment"):
Promise<Record<string, ContainerService> | undefined> {
  const files: string[] = [];
  for (const name of ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"])
    if (await lstat(join(context, name)).catch(() => null)) files.push(name);
  if (!files.length) return undefined;
  if (files.length !== 1) throw new ComposeCapabilityError("Declare exactly one Compose file");
  const file = files[0];
  if (!file) throw new Error("Missing Compose filename");
  const document = record(parse(await readFile(await checkedPath(context, file), "utf8")), "compose");
  keys(document, ["services"], "compose");
  const rawServices = record(document.services, "compose.services");
  const services: Record<string, ContainerService> = {};
  for (const [name, raw] of Object.entries(rawServices)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(name)) throw new ComposeCapabilityError("Invalid Compose service name");
    const service = record(raw, `compose.services.${name}`);
    const deployment = service.deploy;
    const resources = deployment && typeof deployment === "object" && "resources" in deployment
      ? deployment.resources : undefined;
    const reservations = resources && typeof resources === "object" && "reservations" in resources
      ? resources.reservations : undefined;
    const devices = reservations && typeof reservations === "object" && "devices" in reservations ? reservations.devices : undefined;
    const reservedGpu = Array.isArray(devices) && devices.some((device: unknown) => device && typeof device === "object" &&
      ("driver" in device && device.driver === "nvidia" || "capabilities" in device && Array.isArray(device.capabilities) && device.capabilities.includes("gpu")));
    if (service.gpus !== undefined || service.runtime === "nvidia" || reservedGpu)
      throw new ComposeCapabilityError(gpuRequirementMessage(hardware, `${requirement} compose.services.${name}`));
    keys(service, ["build", "image", "command", "entrypoint", "environment", "depends_on", "healthcheck", "expose",
      "network_mode", "extra_hosts", "cpus", "mem_limit", "shm_size", "cap_add", "pull_policy", "working_dir", "user", "init"], `compose.services.${name}`);
    if (service.network_mode !== undefined && (typeof service.network_mode !== "string" || !/^service:[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(service.network_mode)))
      throw new ComposeCapabilityError("Only task-local service network sharing is supported");
    if (service.cap_add !== undefined && (!Array.isArray(service.cap_add) || service.cap_add.some(cap => cap !== "SYS_PTRACE")))
      throw new ComposeCapabilityError("Only SYS_PTRACE capability is supported");
    if (service.image !== undefined && (typeof service.image !== "string" || !service.image.trim())) throw new ComposeCapabilityError("Invalid Compose image");
    const image = name === "main" ? mainImage ?? service.image : service.image;
    let build: EnvironmentSpec["build"];
    // Published task packages can retain a source build recipe alongside an
    // image. Only the selected image is needed; its fallback context may not
    // be shipped in the package at all.
    if (service.build !== undefined && image === undefined) {
      const declaration = typeof service.build === "string" ? { context: service.build } : record(service.build, "compose.build");
      keys(declaration, ["context", "dockerfile", "no_cache"], "compose.build");
      if (declaration.context !== undefined && typeof declaration.context !== "string") throw new ComposeCapabilityError("Invalid build context");
      if (declaration.dockerfile !== undefined && typeof declaration.dockerfile !== "string") throw new ComposeCapabilityError("Invalid Dockerfile");
      if (declaration.no_cache !== undefined && typeof declaration.no_cache !== "boolean") throw new ComposeCapabilityError("Invalid no_cache");
      const buildContext = inside(context, String(declaration.context ?? "."));
      const buildOffset = relative(context, buildContext).replaceAll("\\", "/");
      if (buildOffset) await checkedPath(context, buildOffset);
      const dockerfile = String(declaration.dockerfile ?? "Dockerfile");
      inside(buildContext, dockerfile);
      await checkedPath(buildContext, dockerfile);
      const manifest = await buildFileManifest(buildContext, []);
      if (manifest.missing.length) throw new ComposeCapabilityError("Unsafe Compose build context");
      build = { context: buildContext, dockerfile, sourceHash: fingerprintConfig(manifest.files as unknown as JsonValue), visibility,
        ...(declaration.no_cache === true ? { noCache: true } : {}) };
    }
    const { build: _build, image: _image, pull_policy: _pull, ...properties } = service;
    assertJsonValue(properties);
    services[name] = { image: typeof image === "string" ? image : null,
      ...(build ? { build } : {}), properties };
  }
  for (const [name, service] of Object.entries(services)) {
    if (name !== "main" && !service.image && !service.build) throw new ComposeCapabilityError(`Service ${name} has no image or build`);
    const depends = service.properties.depends_on;
    const names = Array.isArray(depends) ? [...depends] : depends === undefined ? [] : Object.keys(record(depends, "depends_on"));
    const shared = service.properties.network_mode;
    if (typeof shared === "string") names.push(shared.slice("service:".length));
    for (const dependency of names) if (typeof dependency !== "string" || (dependency !== "main" && !services[dependency]) || dependency === name)
      throw new ComposeCapabilityError(`Invalid dependency of service ${name}: ${String(dependency)}`);
  }
  return services;
}
