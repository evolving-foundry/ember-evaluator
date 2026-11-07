import { dockerBuildNetwork } from "./build-network.js";
import { NetworkRuntime } from "../network/runtime.js";
import type { NetworkAccess } from "../../core/contracts/network.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparationCacheSource, RuntimeInstallation, RuntimeInstallCommand, RuntimeLocation } from "../../core/contracts/environment.js";
import { EVALUATOR_NODE_EXECUTABLE, type DockerCommand } from "./runtime-contract.js";
import { type DockerRuntime } from "./runtime.js";
import { DockerBuildCache } from "./build-cache.js";
import { copyRuntimeInventory, runtimeInventory, RuntimeInstallationError } from "../runtime-installation/install.js";
import { dockerImageUser } from "./image-user.js";
import { dockerImageName, type DockerImageScope } from "./image-name.js";

const root = "/opt/evaluator-agent";
const installer = String.raw`import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
const root = process.argv[2] ?? "/opt/evaluator-agent";
const manifest = JSON.parse(await readFile(process.argv[3] ?? "/opt/evaluator/installation.json", "utf8"));
for (const command of [...manifest.commands, ...manifest.probes]) {
  const expand = value => value.replaceAll("{root}", root);
  const cwd = resolve(root, command.cwd ?? ".");
  const rel = relative(root, cwd);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("unsafe runtime cwd");
  // Probes must use the Node running this trusted installer, even when a task PATH shadows it.
  const executable = command.executable === "node" ? process.execPath : expand(command.executable);
  const child = spawn(executable, command.args.map(expand), {
    cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value)])) },
    stdio: "inherit", shell: false,
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve(signal ? null : code)); });
  if (code !== 0) throw new Error("runtime command failed: " + command.executable + " (" + code + ")");
}
`;
const installationDockerfile = (nodeImage: string, pythonMirror: boolean) =>
  [
    `FROM ${nodeImage}`,
    `COPY inputs/ ${root}/`,
    "COPY install-runtime.mjs /opt/evaluator/install-runtime.mjs",
    "COPY installation.json /opt/evaluator/installation.json",
    "ARG NPM_CONFIG_REGISTRY",
    "ARG PIP_INDEX_URL",
    ...(pythonMirror ? ["ARG UV_PYTHON_INSTALL_MIRROR"] : []),
    // Set permissions in the installation layer once; task COPY preserves them for any USER.
    `RUN ${EVALUATOR_NODE_EXECUTABLE} /opt/evaluator/install-runtime.mjs && chmod -R a+rX ${root} && mkdir -p ${root}/state && chmod 1777 ${root}/state`,
  ].join("\n") + "\n";
const derivedDockerfile = (runtimeImage: string, baseImage: string, user: string) =>
  [
    `FROM ${runtimeImage} AS solver_runtime`,
    `FROM ${baseImage}`,
    "USER 0:0",
    `COPY --from=solver_runtime ${root} ${root}`,
    "COPY --chmod=0444 install-runtime.mjs /opt/evaluator/install-runtime.mjs",
    "COPY --chmod=0444 installation.json /opt/evaluator/installation.json",
    `USER ${user}`,
    `RUN ["${EVALUATOR_NODE_EXECUTABLE}", "/opt/evaluator/install-runtime.mjs"]`,
  ].join("\n") + "\n";

type InstalledRuntime = { image: string; digest: string; identity: string; probes: RuntimeInstallCommand[] };
type SolverImage = { image: string; digest: string; runtime: RuntimeLocation };

/**
 * The runtime does not depend on the task: it is installed once per Docker host
 * on the pinned Node image, and each task image copies it and reruns the probes.
 */
export class DockerSolverRuntime {
  private readonly installs = new DockerBuildCache<InstalledRuntime>();
  private readonly images = new DockerBuildCache<SolverImage>();
  constructor(
    private readonly command: DockerCommand,
    private readonly node: DockerRuntime,
    private readonly network: NetworkAccess = new NetworkRuntime(),
  ) {}

  private async imageId(image: string, signal: AbortSignal): Promise<string> {
    const digest = (
      await this.command(["image", "inspect", "--platform", this.node.platform, image, "--format", "{{.Id}}"], { signal })
    ).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", `invalid image digest for ${image}`);
    return digest;
  }

  private async build(
    image: string,
    files: (context: string) => Promise<unknown>,
    args: string[],
    what: string,
    signal: AbortSignal,
    env?: NodeJS.ProcessEnv,
  ): Promise<string> {
    const context = await mkdtemp(join(tmpdir(), "evaluator-solver-image-"));
    try {
      await files(context);
      await this.command(["build", "--platform", this.node.platform, "--tag", image, ...args, context], {
        ...(env ? { env } : {}),
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      return await this.imageId(image, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new RuntimeInstallationError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `${what} build failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }

  async install(installation: RuntimeInstallation, signal: AbortSignal): Promise<InstalledRuntime> {
    const inventory = await runtimeInventory(installation, this.node.platform, signal);
    const nodeDigest = await this.node.nodeImageDigest(signal);
    const network = dockerBuildNetwork(this.network);
    const dockerfile = network.recipe(installationDockerfile(this.node.nodeImage, Boolean(this.network.settings.sources.python.interpreter)));
    const key = createHash("sha256")
      .update(JSON.stringify({ nodeDigest, platform: this.node.platform, identity: inventory.identity, installer, dockerfile, network: network.identity }))
      .digest("hex");
    const image = dockerImageName("solver-install", key);
    return this.installs.getImage(this.node.dockerExecutable, image, signal, async buildSignal => {
      const installed = (digest: string) => ({ image, digest, identity: inventory.identity, probes: inventory.probes });
      try {
        return installed(await this.imageId(image, buildSignal));
      } catch {
        buildSignal.throwIfAborted();
      }
      const registryArgs = network.buildArgs;
      const digest = await this.build(
        image,
        async context => {
          await mkdir(join(context, "inputs"));
          await copyRuntimeInventory(inventory, join(context, "inputs"), buildSignal);
          await Promise.all([
            writeFile(join(context, "install-runtime.mjs"), installer),
            writeFile(
              join(context, "installation.json"),
              JSON.stringify({ commands: inventory.commands, probes: inventory.probes }),
            ),
            writeFile(join(context, "Dockerfile"), dockerfile),
          ]);
        },
        registryArgs,
        "solver runtime image",
        buildSignal,
        network.environment,
      );
      return installed(digest);
    });
  }

  async prepare(baseImage: string, baseDigest: string, installation: RuntimeInstallation, signal: AbortSignal, observe?: (source: PreparationCacheSource) => void, scope?: DockerImageScope): Promise<SolverImage> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(baseDigest))
      throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "solver image base must be pinned by digest");
    const installed = await this.install(installation, signal);
    // Keep using the named image to inspect USER; baseDigest selects its platform identity.
    const user = await dockerImageUser(this.command, baseImage, this.node.platform, signal);
    const key = createHash("sha256")
      .update(JSON.stringify({ baseDigest, runtime: installed.digest, installer, derived: derivedDockerfile("", "", user) }))
      .digest("hex");
    const image = dockerImageName(scope ? "agent" : "solve-agent", key, scope);
    return this.images.getImage(this.node.dockerExecutable, image, signal, async buildSignal => {
      const runtime = { root, stateRoot: `${root}/state`, persistent: false, identity: installed.identity };
      try {
        const digest = await this.imageId(image, buildSignal);
        observe?.("image");
        return { image, digest, runtime };
      } catch {
        buildSignal.throwIfAborted();
      }
      const pinnedBase = dockerImageName(scope ? "agent-base" : "solve-agent-base", baseDigest, scope);
      await this.command(["image", "tag", baseImage, pinnedBase], { signal: buildSignal });
      if ((await this.imageId(pinnedBase, buildSignal)) !== baseDigest)
        throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "solver image base tag changed during pinning");
      if ((await this.imageId(installed.image, buildSignal)) !== installed.digest)
        throw new RuntimeInstallationError("ENV_RUNTIME_INSTALL_FAILED", "solver runtime image changed after installation");
      const digest = await this.build(
        image,
        context =>
          Promise.all([
            writeFile(join(context, "install-runtime.mjs"), installer),
            writeFile(join(context, "installation.json"), JSON.stringify({ commands: [], probes: installed.probes })),
            writeFile(join(context, "Dockerfile"), derivedDockerfile(installed.image, pinnedBase, user)),
          ]),
        [],
        "solver image",
        buildSignal,
      );
      observe?.("built");
      return { image, digest, runtime };
    }, observe);
  }
}
