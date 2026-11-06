import { fileURLToPath } from "node:url";
import type { NetworkSettings, NetworkLocation } from "../../core/contracts/network.js";

const controlled = /^(?:https?_proxy|all_proxy|no_proxy|hf_endpoint|git_ssh_command|evaluator_ssh_proxy|pip_(?:index_url|extra_index_url|trusted_host|config_file)|uv_(?:default_index|index_url|extra_index_url|index|python_install_mirror)|npm_config_(?:registry|proxy|https_proxy|noproxy)|corepack_npm_registry|evaluator_(?:debian_mirror|github_mirror|node_mirror|node_image_mirror|docker_build_network|network_config))$/iu;

export function networkEnvironment(settings: NetworkSettings, location: NetworkLocation, base: NodeJS.ProcessEnv = {}, target: "host" | "container" = location === "build" ? "container" : "host"): Record<string, string> {
    const env: Record<string, string> = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined && !controlled.test(entry[0])));
    const proxy = settings.proxy[location];
    for (const [key, value] of Object.entries({ HTTP_PROXY: proxy.http ?? "", HTTPS_PROXY: proxy.https ?? "", ALL_PROXY: "", NO_PROXY: proxy.noProxy.join(",") })) {
      env[key] = env[key.toLowerCase()] = value;
    }
    const sources = settings.sources;
    Object.assign(env, {
      HF_ENDPOINT: sources.huggingface,
      PIP_INDEX_URL: sources.python.index, PIP_EXTRA_INDEX_URL: sources.python.extraIndexes.join(" "), PIP_TRUSTED_HOST: "",
      UV_DEFAULT_INDEX: sources.python.index, UV_INDEX_URL: sources.python.index, UV_EXTRA_INDEX_URL: sources.python.extraIndexes.join(" "),
      NPM_CONFIG_REGISTRY: sources.npm.registry, npm_config_registry: sources.npm.registry, COREPACK_NPM_REGISTRY: sources.npm.registry,
      EVALUATOR_GITHUB_MIRROR: sources.github.repository, EVALUATOR_NODE_MIRROR: sources.node.dist,
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${sources.github.repository}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/",
    });
    if (sources.python.interpreter) env.UV_PYTHON_INSTALL_MIRROR = sources.python.interpreter;
    // Do not inherit package-manager config files with unrelated indexes.
    env.PIP_CONFIG_FILE = target === "host" && process.platform === "win32" ? "NUL" : "/dev/null";
    env.UV_NO_CONFIG = "1";
    if (target === "host") env.GIT_SSH_COMMAND = "ssh";
    if (settings.git.ssh.route === "proxy" && target === "host") {
      const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
      const helper = fileURLToPath(new URL("./ssh-proxy.js", import.meta.url)).replaceAll("\\", "/");
      // Proxy credentials stay in the child's environment, never command arguments.
      env.EVALUATOR_SSH_PROXY = proxy.https ?? proxy.http ?? "";
      env.GIT_SSH_COMMAND = `ssh -o ${shellQuote(`ProxyCommand=${shellQuote(process.execPath.replaceAll("\\", "/"))} ${shellQuote(helper)} %h %p`)}`;
    }
    return env;
}
