import { randomUUID } from "node:crypto";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import { classifyError } from "../../core/errors/classify.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { DockerBuildCache } from "./build-cache.js";
import { removeDockerContainer } from "./cleanup.js";
import type { DockerCommand } from "./runtime-contract.js";

export type DockerPlatformSelection = "auto" | ContainerPlatform;
export type PlatformResolution = {
  platform: ContainerPlatform;
  source: "benchmark" | "native";
  nativePlatform: ContainerPlatform;
  execution: "native" | "qemu";
};

export function parseDockerPlatform(value: unknown = "auto"): DockerPlatformSelection {
  if (value === "auto" || value === "linux/amd64" || value === "linux/arm64") return value;
  throw new TypeError("docker platform must be auto, linux/amd64 or linux/arm64");
}

export function parseDockerEmulation(value: unknown = true): boolean {
  if (typeof value !== "boolean") throw new TypeError("docker allowEmulation must be a boolean");
  return value;
}

/** YAML supplements a missing benchmark declaration; it never overrides one. */
export function resolveDockerPlatform(selection: DockerPlatformSelection, benchmark: ContainerPlatform | undefined,
  nativePlatform: ContainerPlatform, allowEmulation = true): PlatformResolution {
  parseDockerPlatform(selection);
  if (benchmark !== undefined && benchmark !== "linux/amd64" && benchmark !== "linux/arm64")
    throw new EvaluatorError("ENV_ARCH_UNSUPPORTED", `Unsupported benchmark platform: ${String(benchmark)}`);
  const requirement = benchmark ?? (selection === "auto" ? undefined : selection);
  const platform = requirement ?? nativePlatform;
  if (!allowEmulation && platform !== nativePlatform)
    throw new EvaluatorError("ENV_ARCH_UNSUPPORTED",
      `Task requires ${platform}; Docker daemon is ${nativePlatform} and allowEmulation is false`);
  return { platform, source: requirement ? "benchmark" : "native",
    nativePlatform, execution: platform === nativePlatform ? "native" : "qemu" };
}

export function parseDockerNativePlatform(value: string): ContainerPlatform {
  const aliases: Record<string, ContainerPlatform> = {
    "linux/amd64": "linux/amd64", "linux/x86_64": "linux/amd64", "linux/x64": "linux/amd64",
    "linux/arm64": "linux/arm64", "linux/aarch64": "linux/arm64",
  };
  const platform = aliases[value.trim()];
  if (!platform) throw new EvaluatorError("ENV_ARCH_UNSUPPORTED",
    `Docker daemon platform is ${value.trim() || "unknown"}; only linux/amd64 and linux/arm64 are supported`);
  return platform;
}

export function nodePlatform(platform: ContainerPlatform): string {
  return platform === "linux/amd64" ? "linux/x64" : "linux/arm64";
}

/** Detect the actual Docker execution node, including when the CLI runs in a toolbox. */
export class PlatformCapabilityDetector {
  private readonly native = new DockerBuildCache<ContainerPlatform>();
  private readonly emulation = new DockerBuildCache<void>();

  constructor(private readonly command: DockerCommand,
    private readonly onWarning: (message: string) => void = message => { process.stderr.write(`[warn] [environment] ${message}\n`); }) {}

  async nativePlatform(signal: AbortSignal): Promise<ContainerPlatform> {
    return this.native.get("daemon", signal, async active => {
      let response;
      try { response = await this.command(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"], { signal: active }); }
      catch (cause) {
        active.throwIfAborted();
        throw new EvaluatorError("ENV_DOCKER_DAEMON_UNAVAILABLE", "Cannot query Docker daemon platform",
          { component: "docker", operation: "version" }, { cause });
      }
      return parseDockerNativePlatform(response.stdout);
    });
  }

  async ensure(resolution: PlatformResolution, signal: AbortSignal,
    prepareProbeImage: (signal: AbortSignal) => Promise<string>): Promise<void> {
    signal.throwIfAborted();
    if (resolution.execution === "native") return;
    await this.emulation.get(resolution.platform, signal, async active => {
      this.onWarning(`The target platform is ${resolution.platform}, but the execution node is ${resolution.nativePlatform}. Checking and using QEMU emulation may reduce performance, especially for compilation and compute-intensive tasks, and may affect execution time, timeout decisions and evaluation results.`);
      // Pull failures retain their registry/network classification; they do not
      // prove that emulation is unavailable.
      const image = await prepareProbeImage(active);
      const name = `ember-platform-probe-${randomUUID()}`;
      const probeSignal = AbortSignal.any([active, AbortSignal.timeout(30_000)]);
      try {
        await this.command(["create", "--name", name, "--label", "ember.role=platform-probe",
          "--network", "none", "--read-only", "--cpus", "1", "--memory", "256m", "--platform", resolution.platform,
          "--entrypoint", "/usr/local/bin/node", image, "-e",
          "process.stdout.write(process.platform + '/' + process.arch)"], { signal: probeSignal });
        const result = await this.command(["start", "--attach", name], { signal: probeSignal });
        if (result.stdout.trim() !== nodePlatform(resolution.platform))
          throw new EvaluatorError("ENV_ARCH_UNSUPPORTED", `Probe returned ${result.stdout.trim() || "no architecture"}`);
      } catch (cause) {
        active.throwIfAborted();
        if (probeSignal.aborted) throw probeSignal.reason;
        const failure = classifyError(cause, { phase: "environment", component: "docker" });
        if (failure.code !== "ENV_ARCH_UNSUPPORTED")
          throw new EvaluatorError(failure.code,
            `Platform probe for ${resolution.platform} on ${resolution.nativePlatform} failed: ${failure.message}`,
            { ...failure.details, component: "docker", operation: "platform-probe" }, { cause });
        throw new EvaluatorError("ENV_ARCH_UNSUPPORTED",
          `No usable QEMU emulator is available for platform emulation: target platform ${resolution.platform}, Docker execution node ${resolution.nativePlatform}. ` +
          "Check that QEMU/binfmt is installed, registered and compatible, or use a node native to the target platform. Evaluator does not install emulators automatically.",
          { component: "docker", operation: "platform-probe" }, { cause });
      } finally {
        // A cancelled create may still have allocated a container. Reconcile by
        // its unique name with an independent cleanup budget, never by ancestor.
        await removeDockerContainer(this.command, name, AbortSignal.timeout(60_000));
      }
    });
  }
}
