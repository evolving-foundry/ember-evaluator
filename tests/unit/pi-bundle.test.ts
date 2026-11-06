import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, expect, test } from "vitest";

import { disposePiBundle, PiBundleError, stagePiBundle, type StagedPiBundle } from "../../src/runtimes/pi/bundle.js";
import { disposePiBundleRuntime } from "../../src/runtimes/pi/agentbundle-runtime.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";
import { parseSimpleAgentConfig } from "../../src/plugins/solvers/simpleagent.js";

const fixtureBundle = resolve("tests/fixtures/pi-bundle");

test("staging cleanup waits for admission, is repeatable and never removes the source", async () => {
  const staging = Promise.withResolvers<StagedPiBundle>();
  let released = false;
  const disposal = disposePiBundleRuntime({ staged: staging.promise }).then(() => { released = true; });
  const staged = await stagePiBundle({ path: fixtureBundle }, new AbortController().signal);
  try {
    expect(released).toBe(false);
    await access(staged.bundlePath);
    staging.resolve(staged);
    await disposal;
    await disposePiBundle(staging.promise);
    await expect(access(staged.root)).rejects.toMatchObject({ code: "ENOENT" });
    await access(join(fixtureBundle, "bundle.yaml"));
    await expect(disposePiBundle(Promise.reject(new Error("stage already rolled back")))).resolves.toBeUndefined();
  } finally { await rm(staged.root, { recursive: true, force: true }); }
});

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

/** Write a bundle-shaped directory tree into a fresh temp directory. */
async function writeBundle(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-bundle-unit-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content, "utf8");
  }
  return root;
}

const manifest = (overrides?: string): string =>
  `kind: pi-agent-bundle\nextensions:\n  - ./extensions/demo\n${overrides ?? ""}`;
const extensionPackage = JSON.stringify({
  name: "demo-extension",
  pi: { extensions: ["./extension.js"] },
});
const extensionEntry = "export default function extension() {}\n";

async function stage(path: string, settings?: Record<string, unknown>) {
  return await stagePiBundle({ path, ...(settings === undefined ? {} : { settings }) }, new AbortController().signal);
}

test("stagePiBundle stages an isolated copy and resolves entries and python dependencies", async () => {
  const staged = await stage(fixtureBundle);
  roots.push(staged.root);
  expect(staged.entries).toEqual(["extensions/demo/extension.js"]);
  expect(staged.pythonPackages).toEqual(["demo-required==1.0.0", "demo-optional==2.0.0"]);
  expect(staged.pythonRequiredModules).toEqual(["demo_required"]);
  const copy = await readFile(join(staged.root, "bundle", "bundle.yaml"), "utf8");
  expect(copy).toContain("pi-agent-bundle");
});

test("stagePiBundle keeps a missing dependencies.lock install-free", async () => {
  const root = await writeBundle({
    "bundle.yaml": manifest(),
    "extensions/demo/package.json": extensionPackage,
    "extensions/demo/extension.js": extensionEntry,
  });
  const staged = await stage(root);
  expect(staged.pythonPackages).toEqual([]);
  expect(staged.pythonRequiredModules).toEqual([]);
});

test("stagePiBundle overrides settings.json in the copy and leaves the original untouched", async () => {
  const root = await writeBundle({
    "bundle.yaml": manifest(),
    "settings.json": JSON.stringify({ version: 1, demo: { enabled: false } }),
    "extensions/demo/package.json": extensionPackage,
    "extensions/demo/extension.js": extensionEntry,
  });
  const staged = await stage(root, { version: 1, demo: { enabled: true } });
  const copied = JSON.parse(await readFile(join(staged.root, "bundle", "settings.json"), "utf8")) as unknown;
  expect(copied).toEqual({ version: 1, demo: { enabled: true } });
  const original = JSON.parse(await readFile(join(root, "settings.json"), "utf8")) as unknown;
  expect(original).toEqual({ version: 1, demo: { enabled: false } });
});

test("stagePiBundle rejects missing or malformed manifests", async () => {
  const missing = await writeBundle({});
  await expect(stage(missing)).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED", name: "PiBundleError" });

  const wrongKind = await writeBundle({ "bundle.yaml": "kind: something-else\nextensions: [./extensions/demo]\n" });
  await expect(stage(wrongKind)).rejects.toThrow(/unsupported bundle kind/);

  const empty = await writeBundle({
    "bundle.yaml": "kind: pi-agent-bundle\nextensions: []\n",
    "extensions/demo/package.json": extensionPackage,
    "extensions/demo/extension.js": extensionEntry,
  });
  await expect(stage(empty)).rejects.toThrow(/extensions must be a non-empty array/);
});

test("stagePiBundle rejects unsafe extension paths", async () => {
  const escaping = await writeBundle({
    "bundle.yaml": "kind: pi-agent-bundle\nextensions:\n  - ../outside\n",
  });
  await expect(stage(escaping)).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });

  const absolute = await writeBundle({
    "bundle.yaml": `kind: pi-agent-bundle\nextensions:\n  - /etc/passwd\n`,
  });
  await expect(stage(absolute)).rejects.toThrow(/not a safe relative path/);
});

test("stagePiBundle rejects extensions without usable pi entries", async () => {
  const noPi = await writeBundle({
    "bundle.yaml": manifest(),
    "extensions/demo/package.json": JSON.stringify({ name: "demo-extension" }),
    "extensions/demo/extension.js": extensionEntry,
  });
  await expect(stage(noPi)).rejects.toThrow(/has no pi field/);

  const missingEntry = await writeBundle({
    "bundle.yaml": manifest(),
    "extensions/demo/package.json": extensionPackage,
  });
  await expect(stage(missingEntry)).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
  await expect(stage(missingEntry)).rejects.toThrow(/does not exist in the bundle/);
});

test("stagePiBundle rejects malformed dependencies locks", async () => {
  const broken = await writeBundle({
    "bundle.yaml": manifest(),
    "dependencies.lock": "{ not json",
    "extensions/demo/package.json": extensionPackage,
    "extensions/demo/extension.js": extensionEntry,
  });
  await expect(stage(broken)).rejects.toMatchObject({ code: "ENV_RUNTIME_INSTALL_FAILED" });
  await expect(stage(broken)).rejects.toThrow(/dependencies\.lock is not valid JSON/);

  const badPackages = await writeBundle({
    "bundle.yaml": manifest(),
    "dependencies.lock": JSON.stringify({ python: { packages: [{ module: "x" }] } }),
    "extensions/demo/package.json": extensionPackage,
    "extensions/demo/extension.js": extensionEntry,
  });
  await expect(stage(badPackages)).rejects.toThrow(/need module, package, pin and kind/);
});

test("stagePiBundle honours an aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(stagePiBundle({ path: fixtureBundle }, controller.signal)).rejects.toThrow();
});

function runnerInputSource(extensions?: string[]) {
  return {
    schemaVersion: 1 as const,
    key: { runId: "run", taskId: "task", attemptId: "attempt" },
    input: { id: "task", prompt: "prompt" },
    model: { name: "model", endpoint: null, provider: null, api: null },
    auth: { value: "secret", reference: null },
    workdir: "/work",
    outputDir: "/out",
    ...(extensions === undefined ? {} : { extensions }),
  };
}

test("projectRunnerInput and parseRunnerInput round-trip extensions", () => {
  const projected = projectRunnerInput(runnerInputSource(["/opt/evaluator-agent/bundle/extensions/demo/extension.js"]));
  expect(projected.extensions).toEqual(["/opt/evaluator-agent/bundle/extensions/demo/extension.js"]);
  const parsed = parseRunnerInput(JSON.parse(JSON.stringify(projected)) as unknown);
  expect(parsed.extensions).toEqual(["/opt/evaluator-agent/bundle/extensions/demo/extension.js"]);

  const without = projectRunnerInput(runnerInputSource());
  expect(without.extensions).toBeUndefined();
  expect(parseRunnerInput(JSON.parse(JSON.stringify(without)) as unknown).extensions).toBeUndefined();
});

test("parseRunnerInput rejects invalid extensions", () => {
  expect(() => parseRunnerInput(runnerInputSource([]))).toThrow(/extensions must be a non-empty array/);
  const nonText = { ...runnerInputSource(), extensions: ["/a", 5] };
  expect(() => parseRunnerInput(nonText)).toThrow(/extensions\[1\]/);
  expect(() => parseRunnerInput(runnerInputSource(["/a", ""]))).toThrow(/extensions\[1\]/);
});

test("parseSimpleAgentConfig accepts empty, path-only and full bundle configs", () => {
  expect(parseSimpleAgentConfig({})).toEqual({});
  expect(parseSimpleAgentConfig({ bundle: { path: "bundles/pi" } })).toEqual({
    bundle: { path: "bundles/pi" },
  });
  const settings = { version: 1, office: { enabled: true, readOnly: false } };
  const parsed = parseSimpleAgentConfig({ bundle: { path: "bundle", settings } });
  expect(parsed.bundle?.settings).toEqual(settings);
  // The settings must be a detached copy: later mutations of the source cannot leak into the staged file.
  settings.version = 2;
  expect(parsed.bundle?.settings).toEqual({ version: 1, office: { enabled: true, readOnly: false } });
});

test("parseSimpleAgentConfig rejects unknown fields and invalid values", () => {
  expect(() => parseSimpleAgentConfig({ extra: 1 })).toThrow(/unknown field extra/);
  expect(() => parseSimpleAgentConfig({ bundle: { path: "" } })).toThrow(/bundle\.path/);
  expect(() => parseSimpleAgentConfig({ bundle: { path: "b", unexpected: true } })).toThrow(/unknown field unexpected/);
  expect(() => parseSimpleAgentConfig({ bundle: { path: "b", settings: [] } })).toThrow(/bundle\.settings/);
  expect(() => parseSimpleAgentConfig({ bundle: "bundle" })).toThrow(/simpleagent\.bundle/);
});

test("Pi bundles and shell timeout policy can be configured together", () => {
  const toolPolicy = { shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300 };
  expect(parseSimpleAgentConfig({ bundle: { path: "bundle" }, toolPolicy })).toEqual({
    bundle: { path: "bundle" }, toolPolicy,
  });
  expect(parseSimpleAgentConfig({ toolPolicy })).toEqual({ toolPolicy });
  expect(() => parseSimpleAgentConfig({ bundle: { path: "bundle" }, toolPolicy: {
    shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 90,
  } })).toThrow(/shellMaxTimeoutSeconds/);
});

test("PiBundleError carries its code", () => {
  const error = new PiBundleError("ENV_RUNTIME_INSTALL_FAILED", "detail");
  expect(error.code).toBe("ENV_RUNTIME_INSTALL_FAILED");
  expect(error.message).toBe("ENV_RUNTIME_INSTALL_FAILED: detail");
});
