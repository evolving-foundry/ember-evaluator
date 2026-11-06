import { packageManagerCli } from "../../infrastructure/network/package-manager.js";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { NetworkAccess } from "../../core/contracts/network.js";
import { networkCommand } from "../../infrastructure/network/command.js";
import { formatError } from "../../core/errors/diagnostics.js";
import { runDockerCommand } from "../../infrastructure/containers/command.js";
import { PlatformCapabilityDetector } from "../../infrastructure/containers/platform.js";
import { downloadRegistryImage, mirrorImageReference } from "../../infrastructure/containers/registry-image.js";
import { downloadSkopeoImage } from "../../infrastructure/containers/skopeo-image.js";
import { dockerBuildNetwork } from "../../infrastructure/containers/build-network.js";

export type NetworkProbe = {
  name: string; location: string; target: string; route: string;
  status: "passed" | "failed" | "not-checked" | "not-applicable";
  elapsedMs: number; evidence: string;
  guidance?: { yamlFields: string[]; action: string };
};

/** Explicit, disposable downloads. Never install packages into the host or infer a pass from cached layers. */
export async function diagnoseNetwork(network: NetworkAccess, signal: AbortSignal,
  options: { docker?: string | false; benchmark?: string; datasetUrl?: string; location?: string; progress?: (probe: NetworkProbe) => void } = {}): Promise<NetworkProbe[]> {
  const directory = await mkdtemp(join(tmpdir(), "evaluator-network-doctor-"));
  const results: NetworkProbe[] = [];
  const location = options.location ?? hostname();
  const guidance = (name: string, result: Pick<NetworkProbe, "status" | "evidence">): NetworkProbe["guidance"] => {
    if (result.status === "passed" || result.status === "not-applicable") return undefined;
    if (name === "benchmark-archive" && result.status === "not-checked") return { yamlFields: [], action:
      "归档按任务、平台和用途拼接文件地址；使用同一份网络 YAML 执行 warmup，实际下载并导入所选任务镜像。" };
    if (result.status === "not-checked") return { yamlFields: [], action:
      "缓存或现有镜像不足以证明真实下载，不能按网络失败处理；保留当前 YAML，使用未缓存的目标补验。" };
    const sourceFields: Record<string, string[]> = {
      huggingface: ["sources.huggingface"], "github-api": ["sources.github.api"],
      "github-file": ["sources.github.raw"], "git-https": ["sources.github.repository"],
      "node-distribution": ["sources.node.dist"], pip: ["sources.python.index", "sources.python.extraIndexes"],
      uv: ["sources.python.index", "sources.python.extraIndexes"], npm: ["sources.npm.registry"],
      pnpm: ["sources.npm.registry"], "python-interpreter": ["sources.python.interpreter"],
    };
    const fields = sourceFields[name];
    if (name === "dataset-archive") return { yamlFields: options.datasetUrl?.startsWith("https://huggingface.co/")
      ? ["sources.huggingface", "proxy.overrides.host"] : options.datasetUrl?.startsWith("https://github.com/")
        ? ["sources.github.repository", "proxy.overrides.host"] : ["proxy.overrides.host"],
      action: "Check the selected experiment's benchmark.config.source.url and the indicated network YAML fields. Keep the pinned file and checksum; do not replace the dataset with a different release." };
    if (fields) return { yamlFields: fields, action:
      "核对上面的失败目标和原因，将所列 YAML 字段改为本机可直连的源后重跑 doctor。若提示程序不存在，先安装对应工具；认证失败应检查凭据，不要通过换源掩盖。proxy.http/https 保持 null 即不使用代理。" };
    if (name === "docker-from") return { yamlFields: [], action:
      "FROM 使用当前 Docker daemon 的网络，docker.mirrors 不会改写 FROM。检查 Docker/buildx 和 daemon 到目标 registry 的连接；只改网络 YAML 无法修复 daemon 的连接。无代理运行可选择能直连的预构建任务镜像，通过 docker.pull 下载。" };
    if (name === "docker-run") return { yamlFields: ["sources.apt", "docker.buildNetwork", "proxy.overrides.build"], action:
      "检查失败发生在 FROM 还是 RUN；FROM 失败按 docker-from 提示处理。RUN 下载失败时将 sources.apt 中对应发行版源改为容器可直连地址，检查 docker.buildNetwork 的 DNS/网络；无代理时 build 的 http/https 保持 null。" };
    if (name === "benchmark-archive") return { yamlFields: [`docker.benchmarks.${options.benchmark}.baseUrl`], action:
      "填写所选 benchmark 的镜像目录下载根地址，按任务 ID、平台和用途上传 tar.gz 后执行 warmup。" };
    if (name === "git-ssh") return { yamlFields: ["git.ssh.route", "proxy.overrides.host"], action:
      "检查 SSH 凭据、known_hosts 和 CONNECT 地址；不使用代理时将 git.ssh.route 设为 direct，HTTPS Git 下载地址由 sources.github.repository 控制。" };
    return { yamlFields: [name === "benchmark-image-acquisition" ? `docker.benchmarks.${options.benchmark}` : "docker.pull", "docker.mirrors"], action:
      "核对镜像来源、认证及失败原因。无代理下载可设置 docker.pull.method=registry-client、backend=nodejs，并将 docker.mirrors 的对应 registry 改为可直连镜像源；skopeo 后端需安装支持 copy --preserve-digests 的版本。不会自动切换来源或后端。" };
  };
  const probe = async (name: string, target: string, route: string, run: (active: AbortSignal) => Promise<string | { status: NetworkProbe["status"]; evidence: string }>) => {
    signal.throwIfAborted();
    const started = performance.now();
    let result: Pick<NetworkProbe, "status" | "evidence">;
    try {
      const evidence = await run(AbortSignal.any([signal, AbortSignal.timeout(180_000)]));
      result = typeof evidence === "string" ? { status: "passed", evidence } : evidence;
    } catch (error) {
      signal.throwIfAborted();
      result = { status: "failed", evidence: formatError(error, network.secrets) };
    }
    const advice = guidance(name, result);
    const row = { name, location, target, route, elapsedMs: Math.round(performance.now() - started), ...result,
      ...(advice ? { guidance: advice } : {}) };
    results.push(row); options.progress?.(row);
  };
  const hostRoute = network.settings.proxy.host.http || network.settings.proxy.host.https ? "configured host proxy / noProxy" : "direct";
  const download = async (url: string, active: AbortSignal) => {
    const response = await network.fetch(url, { signal: active, headers: { "cache-control": "no-cache" } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    let bytes = 0;
    if (response.body) for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Probe exceeded 16 MiB"); } }
    if (!bytes) throw new Error("Empty download");
    const age = Number(response.headers.get("age") ?? "0");
    return age > 0 ? { status: "not-checked" as const, evidence: `Received ${bytes} bytes; upstream cache age=${age}` } : `Downloaded ${bytes} bytes; HTTP ${response.status}`;
  };
  const environment = network.environment("host", process.env);
  const execute = async (executable: string, args: string[], active: AbortSignal, cwd: string, extra: Record<string, string> = {}) => {
    if (process.platform === "win32" && (executable === "npm" || executable === "pnpm")) {
      args = [await packageManagerCli(executable), ...args]; executable = process.execPath;
    }
    const output = await networkCommand(executable, args, { signal: active, cwd, env: { ...environment, ...extra } });
    if (output.exitCode !== 0) throw new Error(`${executable} exited ${output.exitCode}: ${output.stderr}`);
    return output;
  };
  try {
    if (options.datasetUrl) {
      const target = network.sourceUrl(options.datasetUrl);
      await probe("dataset-archive", target, hostRoute, async active => {
        const response = await network.fetch(target, { signal: active, headers: { range: "bytes=0-1023", "cache-control": "no-cache" } });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Dataset download HTTP ${response.status}`); }
        const reader = response.body.getReader();
        try {
          const chunk = await reader.read();
          if (chunk.done || !chunk.value.length) throw new Error("Empty dataset download");
          const age = Number(response.headers.get("age") ?? "0");
          return age > 0 ? { status: "not-checked" as const, evidence: `Received ${chunk.value.length} sample bytes; upstream cache age=${age}` }
            : `Read ${chunk.value.length} sample bytes; HTTP ${response.status}. Use warmup for full archive validation.`;
        } finally { await reader.cancel(); reader.releaseLock(); }
      });
    }
    for (const [name, target] of [
      ["huggingface", "https://huggingface.co/datasets/openai/gsm8k/resolve/main/README.md"],
      ["github-api", "https://api.github.com/repos/octocat/Hello-World"],
      ["github-file", "https://raw.githubusercontent.com/octocat/Hello-World/master/README"],
      ["node-distribution", "https://nodejs.org/dist/v24.19.0/SHASUMS256.txt"],
    ]) {
      const targetUrl = network.sourceUrl(target!);
      await probe(name!, targetUrl, hostRoute, active => download(targetUrl, active));
    }
    for (const name of ["pip", "uv", "npm", "pnpm"] as const) {
      const work = join(directory, name); await mkdir(work);
      await probe(name, name === "pip" || name === "uv" ? network.settings.sources.python.index : network.settings.sources.npm.registry, hostRoute, async active => {
        if (name === "pip") await execute(process.platform === "win32" ? "python" : "python3", ["-m", "pip", "download", "--no-cache-dir", "--no-deps", "--dest", work, "six==1.17.0"], active, work);
        if (name === "uv") await execute("uv", ["pip", "install", "--no-cache", "--no-deps", "--target", join(work, "packages"), "six==1.17.0"], active, work);
        if (name === "npm") await execute("npm", ["pack", "is-number@7.0.0", "--ignore-scripts", "--cache", join(work, "cache")], active, work);
        if (name === "pnpm") {
          await writeFile(join(work, "package.json"), JSON.stringify({ private: true, dependencies: { "is-number": "7.0.0" } }));
          await execute("pnpm", ["install", "--ignore-scripts", "--store-dir", join(work, "store"), "--registry", network.settings.sources.npm.registry], active, work);
        }
        const entries = await readdir(work);
        const artifact = name === "pip" ? entries.find(file => file.endsWith(".whl"))
          : name === "npm" ? entries.find(file => file.endsWith(".tgz"))
          : name === "uv" ? "packages/six.py" : "node_modules/is-number/package.json";
        if (!artifact || !(await stat(join(work, artifact))).isFile()) throw new Error("Package command did not produce the expected download");
        return "Downloaded fixed package into a fresh temporary directory and verified its artifact";
      });
    }
    await probe("python-interpreter", network.settings.sources.python.interpreter ?? "uv default interpreter source", hostRoute, async active => {
      await execute("uv", ["python", "install", "3.12.14"], active, directory,
        { UV_PYTHON_INSTALL_DIR: join(directory, "python"), UV_CACHE_DIR: join(directory, "uv-cache") });
      if (!(await readdir(join(directory, "python"))).length) throw new Error("Interpreter installation produced no files");
      return "Downloaded Python 3.12.14 into a fresh temporary installation directory";
    });
    await probe("git-https", network.settings.sources.github.repository, hostRoute, async active => {
      await execute("git", ["clone", "--depth", "1", network.settings.sources.github.repository + "/octocat/Hello-World.git", join(directory, "git")], active, directory);
      if (!(await stat(join(directory, "git/.git"))).isDirectory()) throw new Error("Git clone produced no repository");
      return "Fetched Git objects into fresh shallow clone";
    });
    await probe("git-ssh", "git@github.com:octocat/Hello-World.git", network.settings.git.ssh.route, async active => {
      if (network.settings.git.ssh.route === "direct") return { status: "not-applicable", evidence: "SSH proxy is not selected; HTTPS Git was tested separately" };
      await execute("git", ["ls-remote", "git@github.com:octocat/Hello-World.git", "HEAD"], active, directory,
        { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: `${environment.GIT_SSH_COMMAND} -o BatchMode=yes -o StrictHostKeyChecking=yes` });
      return "SSH Git remote returned HEAD through configured CONNECT route";
    });
    if (options.docker === false) return results;
    const docker = options.docker ?? "docker";
    const command: import("../../infrastructure/containers/runtime-contract.js").DockerCommand = (args, opts) => runDockerCommand(docker, args, opts);
    const image = "docker.io/library/busybox:1.37.0";
    const source = mirrorImageReference(image, network.settings.docker.mirrors);
    const selected = options.benchmark ? network.settings.docker.benchmarks[options.benchmark] : undefined;
    const methods = [{ name: "image-acquisition", method: network.settings.docker.pull }];
    if (selected && selected.method !== "archive" && JSON.stringify(selected) !== JSON.stringify(network.settings.docker.pull))
      methods.push({ name: "benchmark-image-acquisition", method: selected });
    for (const { name, method } of methods) await probe(name, source, method.method === "docker" ? "daemon" : hostRoute, async active => {
      const platform = await new PlatformCapabilityDetector(command).nativePlatform(active);
      if (method.method === "docker") {
        const output = await command(["pull", "--platform", platform, source], { signal: active });
        return /Pull complete|Download complete/u.test(output.stdout + output.stderr)
          ? "Docker downloaded image layers" : { status: "not-checked", evidence: "Docker pull succeeded, but layer download could not be distinguished from cache reuse" };
      }
      const target = join(directory, "image"); await mkdir(target);
      const tag = `ember-network-doctor:${randomUUID()}`;
      const downloaded = method.backend === "skopeo"
        ? await downloadSkopeoImage(source, platform, network, method.skopeoExecutable, target, tag, active)
        : await downloadRegistryImage(source, platform, network.settings.proxy.host, target, tag, active);
      try {
        await command(["load", "--input", downloaded.archive], { signal: active });
        const inspected = await command(["image", "inspect", "--platform", platform, tag, "--format", "{{.Id}} {{.Os}}/{{.Architecture}}"], { signal: active });
        const [id, actualPlatform] = inspected.stdout.trim().split(/\s+/u);
        if (![downloaded.configDigest, downloaded.manifestDigest].includes(id ?? "") || actualPlatform !== platform) throw new Error("Imported probe image identity/platform mismatch");
        return `Downloaded, verified and imported registry content ${downloaded.sourceDigest}`;
      } finally { await command(["image", "rm", tag], { signal: AbortSignal.timeout(30_000) }).catch(() => {}); }
    });
    const archive = options.benchmark && network.settings.docker.benchmarks[options.benchmark];
    if (archive && archive.method === "archive") await probe("benchmark-archive", network.sourceUrl(archive.baseUrl), hostRoute, async () => {
      return { status: "not-checked", evidence: "Task archives use fixed paths; run warmup to download and load the selected task/platform images" };
    });
    for (const mode of ["from", "run"] as const) await probe(`docker-${mode}`, "docker.io/library/debian:bookworm-slim", mode === "from" ? "daemon" : "build", async active => {
      const context = join(directory, mode); await mkdir(context);
      const settings = dockerBuildNetwork(network);
      const original = "FROM debian:bookworm-slim\n" + (mode === "run" ? "RUN rm -rf /var/lib/apt/lists/* && apt-get update && cd /tmp && apt-get download hello\n" : "");
      await writeFile(join(context, "Dockerfile"), mode === "run" ? settings.recipe(original) : original);
      const tag = `ember-network-doctor:${randomUUID()}`;
      try {
        const output = await command(["build", "--pull", "--no-cache", "--progress", "plain", "--tag", tag,
          ...(mode === "run" ? settings.buildArgs : []), context], { signal: active, env: settings.environment });
        if (mode === "run") return "RUN fetched fresh apt indexes and downloaded hello with configured build sources";
        return /downloading|Download complete|Pull complete/iu.test(output.stdout + output.stderr)
          ? "FROM downloaded remote content" : { status: "not-checked", evidence: "FROM resolved successfully; existing layers may have been reused" };
      } finally { await command(["image", "rm", tag], { signal: AbortSignal.timeout(30_000) }).catch(() => {}); }
    });
    return results;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
