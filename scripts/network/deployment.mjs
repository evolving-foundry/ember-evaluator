import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { loadNetworkConfig } from "../../dist/config/network.js";
import { storedNetworkTemplate } from "../../dist/config/network-schema.js";
import { NetworkRuntime } from "../../dist/infrastructure/network/runtime.js";
import { dockerBuildNetwork } from "../../dist/infrastructure/containers/build-network.js";
import { createDockerImagePuller } from "../../dist/infrastructure/containers/image-pull.js";
import { runDockerCommand } from "../../dist/infrastructure/containers/command.js";
import { PlatformCapabilityDetector } from "../../dist/infrastructure/containers/platform.js";

export async function deploymentNetwork(configPath) {
  const network = new NetworkRuntime(await loadNetworkConfig(configPath));
  const build = dockerBuildNetwork(network);
  const command = (args, options) => runDockerCommand("docker", args, options);
  const pull = createDockerImagePuller(command, { network });
  return {
    network, build,
    async acquire(reference, signal) {
      const platform = await new PlatformCapabilityDetector(command).nativePlatform(signal);
      return (await pull(reference, platform, signal)).reference;
    },
    async rewriteDockerfile(path) { await writeFile(path, build.recipe(await readFile(path, "utf8"))); },
    async composeOverride(directory, services, signal) {
      await mkdir(directory, { recursive: true });
      const template = storedNetworkTemplate(network.document.template);
      if (JSON.stringify(template).includes("[runtime-provided]")) throw new Error("Deployment network credentials must use environment references");
      const templateFile = join(directory, "network.json");
      await writeFile(templateFile, JSON.stringify(template), { mode: 0o600 });
      const variables = [...new Set([...JSON.stringify(template).matchAll(/\$\{([A-Za-z_]\w*)\}/gu)].map(match => match[1]))];
      const definitions = Object.fromEntries(services.map(name => [name, { environment: { EVALUATOR_NETWORK_CONFIG: "/etc/ember/network.json",
        ...Object.fromEntries(variables.map(name => [name, `\${${name}:?Required by network YAML}`])) },
        volumes: [`${templateFile.replaceAll("\\", "/")}:/etc/ember/network.json:ro`] }]));
      const image = await this.acquire("docker:28.5.1-dind", signal);
      for (const name of ["docker-a", "docker-b"]) definitions[name] = { image, pull_policy: "never",
        labels: { "org.ember.evaluator.network": network.document.digest },
        environment: { HTTP_PROXY: "${EVALUATOR_DAEMON_HTTP_PROXY}", HTTPS_PROXY: "${EVALUATOR_DAEMON_HTTPS_PROXY}", NO_PROXY: "${EVALUATOR_DAEMON_NO_PROXY}" } };
      const path = join(directory, "network-compose.json");
      await writeFile(path, JSON.stringify({ services: definitions }), { mode: 0o600 });
      const proxy = network.settings.proxy.daemon;
      return { path, env: { EVALUATOR_DAEMON_HTTP_PROXY: proxy.http ?? "", EVALUATOR_DAEMON_HTTPS_PROXY: proxy.https ?? "", EVALUATOR_DAEMON_NO_PROXY: proxy.noProxy.join(",") } };
    },
    dispose: () => network.dispose(),
  };
}

// Toolbox is built from a temporary copy; its original Dockerfile remains unchanged.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "toolbox-build") throw new Error("Expected toolbox-build");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const access = await deploymentNetwork();
  const directory = await mkdtemp(join(tmpdir(), "evaluator-toolbox-build-"));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    await cp(join(root, "scripts/toolbox"), directory, { recursive: true });
    await access.rewriteDockerfile(join(directory, "Dockerfile"));
    await runDockerCommand("docker", ["--host", "unix:///var/run/docker.sock", "build", ...access.build.buildArgs,
      "--tag", "ember-evaluator-toolbox:local", directory], { signal: controller.signal, env: access.build.environment,
      onOutput: (stream, bytes) => process[stream].write(bytes) });
  } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); await access.dispose(); await rm(directory, { recursive: true, force: true }); }
}
