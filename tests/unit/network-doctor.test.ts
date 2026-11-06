import { expect, test, vi, afterEach } from "vitest";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { networkDocument } from "../../src/config/network-schema.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { diagnoseNetwork } from "../../src/application/diagnostics/network.js";
import { networkCommand } from "../../src/infrastructure/network/command.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";

vi.mock("../../src/infrastructure/network/command.js", () => ({ networkCommand: vi.fn() }));
vi.mock("../../src/infrastructure/network/package-manager.js", () => ({ packageManagerCli: async (name: string) => `/fixture/${name}.js` }));
vi.mock("../../src/infrastructure/containers/command.js", () => ({ runDockerCommand: vi.fn() }));
vi.mock("../../src/infrastructure/containers/platform.js", () => ({ PlatformCapabilityDetector: class {
  async nativePlatform() { return "linux/amd64"; }
} }));
afterEach(() => vi.restoreAllMocks());

test("doctor separates cached downloads, failed installers and FROM/RUN evidence and removes temporary files", async () => {
  const network = new NetworkRuntime(networkDocument({ sources: { huggingface: "https://hub.test" },
    docker: { benchmarks: { terminalbench: { method: "archive", provider: "modelscope", baseUrl: "https://modelscope.cn/datasets/team/images/resolve/main/tb4" } } } }, {}));
  const fetch = vi.spyOn(network, "fetch").mockImplementation(async input =>
    new Response("fixture file", { headers: String(input).startsWith("https://hub.test") ? { age: "30" } : {} }));
  let directory: string | undefined;
  vi.mocked(networkCommand).mockImplementation(async (executable, args, options) => {
    directory = options.cwd;
    if (!directory) throw new Error("Missing probe working directory");
    if (args.includes("six==1.17.0") && executable !== "uv") return { stdout: "", stderr: "pip refused configured index", exitCode: 1 };
    if (args.includes("six==1.17.0")) {
      const target = args[args.indexOf("--target") + 1]!;
      await mkdir(target); await writeFile(join(target, "six.py"), "# fixture");
    }
    if (args.includes("pack")) await writeFile(join(directory, "is-number-7.0.0.tgz"), "fixture");
    if (args.includes("--store-dir")) {
      await mkdir(join(directory, "node_modules/is-number"), { recursive: true });
      await writeFile(join(directory, "node_modules/is-number/package.json"), "{}");
    }
    if (args[0] === "python") {
      await mkdir(options.env.UV_PYTHON_INSTALL_DIR!, { recursive: true });
      await writeFile(join(options.env.UV_PYTHON_INSTALL_DIR!, "python"), "fixture");
    }
    if (args.includes("clone")) await mkdir(join(args.at(-1)!, ".git"), { recursive: true });
    return { stdout: "downloaded", stderr: "", exitCode: 0 };
  });
  vi.mocked(runDockerCommand).mockImplementation(async (_docker, args, options) => {
    if (args[0] === "build") {
      expect(args).not.toContain("--builder");
      expect(options?.env).toMatchObject({ BUILDX_BUILDER: "", DOCKER_BUILDKIT: "1" });
    }
    return { stdout: "Already exists; done", stderr: "" };
  });
  const results = await diagnoseNetwork(network, AbortSignal.timeout(5000), { benchmark: "terminalbench" });
  expect(results.find(row => row.name === "huggingface")).toMatchObject({ target: "https://hub.test/datasets/openai/gsm8k/resolve/main/README.md", status: "not-checked" });
  expect(results.find(row => row.name === "pip")).toMatchObject({ status: "failed", evidence: expect.stringContaining("pip refused"),
    guidance: { yamlFields: ["sources.python.index", "sources.python.extraIndexes"], action: expect.stringContaining("直连") } });
  expect(results.find(row => row.name === "huggingface")?.guidance).toMatchObject({ yamlFields: [], action: expect.stringContaining("不能按网络失败处理") });
  expect(results.find(row => row.name === "image-acquisition")?.status).toBe("not-checked");
  expect(results.find(row => row.name === "docker-from")?.status).toBe("not-checked");
  expect(results.find(row => row.name === "docker-run")?.status).toBe("passed");
  for (const name of ["uv", "npm", "pnpm", "python-interpreter", "git-https"]) expect(results.find(row => row.name === name)?.status).toBe("passed");
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.some(([input]) => String(input).includes("modelscope.cn"))).toBe(false);
  expect(results.find(row => row.name === "benchmark-archive")).toMatchObject({ status: "not-checked",
    evidence: expect.stringContaining("fixed paths"), guidance: { action: expect.stringContaining("warmup") } });
  expect(directory).toBeDefined();
  await expect(stat(directory!)).rejects.toMatchObject({ code: "ENOENT" });
  await network.dispose();
});

test("cancelled network diagnosis performs no download", async () => {
  const network = new NetworkRuntime(networkDocument({}, {}));
  const fetch = vi.spyOn(network, "fetch");
  await expect(diagnoseNetwork(network, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  await network.dispose();
});

test("doctor reports the actual dataset archive and the source field when its download fails", async () => {
  const network = new NetworkRuntime(networkDocument({ sources: { huggingface: "https://hub.test" } }, {}));
  vi.spyOn(network, "fetch").mockResolvedValue(new Response("denied", { status: 403 }));
  vi.mocked(networkCommand).mockResolvedValue({ stdout: "", stderr: "tool unavailable", exitCode: 1 });
  const probes = await diagnoseNetwork(network, AbortSignal.timeout(5000), { docker: false,
    datasetUrl: "https://huggingface.co/datasets/team/bench/resolve/pinned/tasks.tar.gz" });
  expect(probes[0]).toMatchObject({ name: "dataset-archive", target: "https://hub.test/datasets/team/bench/resolve/pinned/tasks.tar.gz",
    status: "failed", evidence: expect.stringContaining("403"), guidance: { yamlFields: ["sources.huggingface", "proxy.overrides.host"] } });
  expect(probes.some(probe => probe.name.startsWith("docker-"))).toBe(false);
  await network.dispose();
});

test.each([["0", "passed"], ["30", "not-checked"]])("dataset archive samples report cache age %s as %s", async (age, status) => {
  const network = new NetworkRuntime(networkDocument({}, {}));
  const fetch = vi.spyOn(network, "fetch").mockImplementation(async () => new Response("sample", { headers: { age: age! } }));
  vi.mocked(networkCommand).mockResolvedValue({ stdout: "", stderr: "tool unavailable", exitCode: 1 });
  try {
    const probes = await diagnoseNetwork(network, AbortSignal.timeout(5000), { docker: false, datasetUrl: "https://example.test/tasks.tar.gz" });
    expect(probes[0]).toMatchObject({ name: "dataset-archive", status });
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ range: "bytes=0-1023" });
  } finally { await network.dispose(); }
});
