import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, cp, mkdir, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { relative as relativePath, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sourceFingerprint } from "./source-fingerprint.mjs";

async function normalizeRuntimeFile(file) {
  const content = await readFile(file, "utf8");
  await writeFile(file, content.replace(/\r\n?/gu, "\n"));
}

async function normalizeRuntimeText(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await normalizeRuntimeText(path);
    else if (entry.isFile() && (entry.name === "Dockerfile" || /\.(?:m?js|json|py|txt|ya?ml)$/u.test(entry.name))) await normalizeRuntimeFile(path);
  }
}

// Local development uses pnpm, while container installation still uses npm ci.
// Fail at build time instead of shipping a stale npm runtime lock to workers.
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const lockedManifest = lock.packages?.[""];
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (!lockedManifest || !isDeepStrictEqual(manifest[field] ?? {}, lockedManifest[field] ?? {})) {
    throw new Error(`package-lock.json is out of sync with package.json (${field}); run npm install --package-lock-only --ignore-scripts to update the container runtime lock`);
  }
}

// The Pi runtime installs registry dependencies with npm ci. Git subdirectory
// packages are copied into their own runtime layer and must not be resolved by npm.
const runtimeManifest = structuredClone(manifest);
const runtimeLock = structuredClone(lock);
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
    if (typeof specifier !== "string" || !/^(?:git\+|git@|workspace:|link:)/u.test(specifier)) continue;
    delete runtimeManifest[field]?.[name];
    delete runtimeLock.packages[""][field]?.[name];
    delete runtimeLock.packages[`node_modules/${name}`];
  }
}
await writeFile(new URL("../dist/runtimes/pi/runtime-package.json", import.meta.url),
  JSON.stringify(runtimeManifest, null, 2) + "\n");
await writeFile(new URL("../dist/runtimes/pi/runtime-lock.json", import.meta.url),
  JSON.stringify(runtimeLock, null, 2) + "\n");

const root = new URL("../dist/runtimes/pi/", import.meta.url);
await cp(new URL("../src/runtimes/pi/model-defaults.json", import.meta.url), new URL("model-defaults.json", root));
// The standalone Pi runner shares the coordinator's error and HTTP policies.
// Copy only its runtime dependencies and rewrite imports before hashing the Pi bundle.
const copiedModules = new Map();
const runtimeDirectory = fileURLToPath(root);
const distributionDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
async function copyRuntimeModule(source) {
  if (copiedModules.has(source)) return copiedModules.get(source);
  const local = dirname(source) === runtimeDirectory.replace(/[\\/]$/, "");
  const name = local ? relativePath(runtimeDirectory, source) : "runtime-" + relativePath(distributionDirectory, source).replaceAll("\\", "-").replaceAll("/", "-");
  copiedModules.set(source, name);
  let contents = await readFile(source, "utf8");
  const references = [...contents.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+\.js)\1/g)];
  for (const match of references) {
    const target = await copyRuntimeModule(resolve(dirname(source), match[2]));
    contents = contents.replaceAll(match[1] + match[2] + match[1], match[1] + "./" + target + match[1]);
  }
  await writeFile(new URL(name, root), contents);
  return name;
}
// Coordinator-side preparation modules also live here. Keep their original
// imports and resource URLs; only the runner's dependency closure is relocated.
await copyRuntimeModule(fileURLToPath(new URL("runner.js", root)));
await normalizeRuntimeText(root);
const names = (await readdir(root)).filter(name => name === "runtime-lock.json" || name === "runtime-package.json" || name === "model-defaults.json" || name.endsWith(".js")).sort();
const files = {};
for (const name of names) {
  files[name] = `sha256:${createHash("sha256").update(await readFile(new URL(name, root))).digest("hex")}`;
}
const body = { schemaVersion: 1, algorithm: "sha256", files };
const digest = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
await writeFile(new URL("builtin-provenance.json", root), JSON.stringify({ ...body, digest }, null, 2) + "\n");

// Python is an explicit distributed runtime asset, not generated from a JS closure.
const python = new URL("../src/infrastructure/ray/python/", import.meta.url);
const verifierPython = new URL("../dist/plugins/verifiers/python/runtime/", import.meta.url);
await mkdir(verifierPython, { recursive: true });
for (const name of ["worker.py", "workbuddy.py", "Dockerfile", "build-runtime.py"]) {
  await cp(new URL(`../src/plugins/verifiers/python/runtime/${name}`, import.meta.url), new URL(name, verifierPython));
  await normalizeRuntimeFile(new URL(name, verifierPython));
}
try {
  await mkdir(new URL("../dist/infrastructure/ray/python/", import.meta.url), { recursive: true });
  await cp(python, new URL("../dist/infrastructure/ray/python/", import.meta.url), { recursive: true, filter: source => !source.includes("__pycache__") });
} catch (error) { if (error.code !== "ENOENT") throw error; }
// Normalize copied text assets before hashing so Windows and Linux builds
// reproduce the fixed hashes embedded in the AgentBundle CLI provenance.
await normalizeRuntimeText(new URL("../dist/infrastructure/ray/python/", import.meta.url));
const distribution = new URL("../dist/", import.meta.url);
// Keep third-party notices with the copied scoring templates and ports.
await cp(new URL("../src/plugins/benchmarks/agent-harness/definitions/scoring/LICENSE-MIT", import.meta.url),
  new URL("plugins/benchmarks/agent-harness/definitions/scoring/LICENSE-MIT", distribution));
const officeqaAssets = new URL("plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/", distribution);
await mkdir(officeqaAssets, { recursive: true });
for (const name of ["reward.py", "LICENSE-APACHE", "NOTICE"]) {
  await cp(new URL(`../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/runtime/${name}`, import.meta.url), new URL(name, officeqaAssets));
}
// kernel verification and profiling assets ride with the compiled protocol.
const kernelKernelAssets = new URL("../dist/plugins/benchmarks/operator/kernel/runtime/", import.meta.url);
await mkdir(kernelKernelAssets, { recursive: true });
for (const name of ["precision.py", "timing.py", "msprof_replay.py", "strict.py", "timing_evidence.py"]) {
  await cp(new URL(`../src/plugins/benchmarks/operator/kernel/runtime/${name}`, import.meta.url), new URL(name, kernelKernelAssets));
  await normalizeRuntimeFile(new URL(name, kernelKernelAssets));
}
for (const category of ["agent-harness", "inference-engine", "operator"]) {
  await cp(new URL(`../src/plugins/benchmarks/${category}/profiles/`, import.meta.url), new URL(`plugins/benchmarks/${category}/profiles/`, distribution), { recursive: true });
}
// Keep the checkout entrypoint stable so it can refresh stale compiled code.
await rename(new URL("cli.js", distribution), new URL("cli-runtime.js", distribution));
await writeFile(new URL("cli.js", distribution), await readFile(new URL("./cli-bootstrap.mjs", import.meta.url)));
await writeFile(new URL("source-provenance.json", distribution),
  JSON.stringify({ schemaVersion: 1, digest: await sourceFingerprint() }, null, 2) + "\n");
// Fixed standalone upstream CLI and locked harness recipes travel with npm packs.
for (const directory of ["dsh", "deepagents", "dify", "jiuwenswarm", "hermes", "agentx"]) {
  const target = new URL(`../dist/runtimes/${directory}/assets/`, import.meta.url);
  await mkdir(target, { recursive: true });
  await cp(new URL(`../src/runtimes/${directory}/assets/`, import.meta.url), target, { recursive: true });
  await normalizeRuntimeText(target);
}
const agentBundleAssets = new URL("../dist/runtimes/agentbundle/assets/", import.meta.url);
await mkdir(agentBundleAssets, { recursive: true });
await cp(new URL("../src/runtimes/agentbundle/assets/run.mjs", import.meta.url),
  new URL("run.mjs", agentBundleAssets));
// Cluster Jobs runtime is shipped and hashed with the same package as the CLI.
await mkdir(new URL("application/ray/entries/", distribution), { recursive: true });
await mkdir(new URL("adapters/ray/", distribution), { recursive: true });
for (const name of ["jobs-entry", "jobs-gateway", "jobs-retry-entry"]) {
  const code = await readFile(new URL(`../src/application/ray/entries/${name}.mjs`, import.meta.url), "utf8");
  await writeFile(new URL(`application/ray/entries/${name}.mjs`, distribution), code.replaceAll("../../../../dist/", "../../../"));
  await writeFile(new URL(`adapters/ray/${name}.js`, distribution), `await import("../../application/ray/entries/${name}.mjs");\n`);
}
await writeFile(new URL("adapters/ray/node-worker.js", distribution),
  'import { startNodeWorker } from "../../application/ray/node-worker.js";\nawait startNodeWorker().catch(() => { process.stderr.write("Ray node execution failed; retained node evidence may contain details.\\n"); process.exitCode = 1; });\n');
await cp(new URL("infrastructure/ray/python/", distribution), new URL("adapters/ray/python/", distribution), { recursive: true });
// The legacy runner directory remains a complete, independently installable bundle.
const legacyPi = new URL("adapters/harness/pi/", distribution);
await mkdir(legacyPi, { recursive: true });
const legacyNames = new Set([...copiedModules.values(), "model-defaults.json", "runtime-package.json", "runtime-lock.json"]);
for (const name of legacyNames) await cp(new URL(name, root), new URL(name, legacyPi));
const legacyBody = { schemaVersion: 1, algorithm: "sha256", files: Object.fromEntries(Object.entries(files).filter(([name]) => legacyNames.has(name))) };
await writeFile(new URL("builtin-provenance.json", legacyPi), JSON.stringify({ ...legacyBody,
  digest: `sha256:${createHash("sha256").update(JSON.stringify(legacyBody)).digest("hex")}` }, null, 2) + "\n");
await cp(new URL("runtimes/agentx/assets/", distribution), new URL("adapters/harness/agentx/assets/", distribution), { recursive: true });
// Source checkouts may use CRLF on Windows while Docker builds from LF files.
// Canonicalize every packaged text file before computing byte-level provenance.
await normalizeRuntimeText(distribution);
const distributionFiles = {};
async function scan(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await scan(new URL(entry.name + "/", directory), relative + "/");
    else if (/(?:\.(?:m?js|json|py|txt|ya?ml)$|(?:^|\/)Dockerfile$)/.test(relative) && relative !== "package-provenance.json") distributionFiles[relative] = `sha256:${createHash("sha256").update(await readFile(new URL(entry.name, directory))).digest("hex")}`;
  }
}
await scan(distribution);
const sortedFiles = Object.entries(distributionFiles).sort(([a], [b]) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
});
const distributionBody = { schemaVersion: 1, algorithm: "sha256", files: Object.fromEntries(sortedFiles) };
await writeFile(new URL("package-provenance.json", distribution), JSON.stringify({ ...distributionBody, digest: `sha256:${createHash("sha256").update(JSON.stringify(distributionBody)).digest("hex")}` }, null, 2) + "\n");
