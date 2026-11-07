import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { workspaceHelperSource } from "../../src/infrastructure/filesystem/workspace-transfer.js";

const run = promisify(execFile);
const image = process.env.EVALUATOR_DOCKER_TEST_IMAGE;

test.skipIf(!image)("missing optional outputs reach verification without deleting verifier fixtures; required outputs still fail", async () => {
  const base = resolve(".scratch/workspace-transfer-missing");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "proof-"));
  await writeFile(join(directory, "workspace-transfer.mjs"), workspaceHelperSource);
  await writeFile(join(directory, "proof.mjs"), String.raw`
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const helper = "/proof/workspace-transfer.mjs";
const token = "12345678-abcd";
const call = (...args) => execFileSync(process.execPath, [helper, ...args], { stdio: ["ignore", "pipe", "pipe"] });
await mkdir("/workspace", { recursive: true });
await writeFile("/workspace/present", "agent output");
const missing = ["/workspace/results/walk.npz", "/workspace/fixture"];
const spec = { kind: "artifacts", workdir: "/workspace", paths: [...missing, "/workspace/present"], optionalPaths: missing };
call("export", token, JSON.stringify(spec));
const stage = "/opt/evaluator/transfers/" + token;
const manifest = JSON.parse(await readFile(stage + "/manifest.json", "utf8"));
const sha = createHash("sha256").update(await readFile(stage + "/state.tar")).digest("hex");
await writeFile("/workspace/fixture", "trusted verifier fixture");
await writeFile("/workspace/present", "base image output");
call("restore", token, sha);
let absent = false; try { await access(missing[0]); } catch (error) { if (error.code !== "ENOENT") throw error; absent = true; }
let strictFailed = false;
try { call("export", "23456789-abcd", JSON.stringify({ ...spec, optionalPaths: [] })); }
catch (error) { if (!String(error.stderr).includes("ENOENT")) throw error; strictFailed = true; }
console.log(JSON.stringify({ present: manifest.present, absent, strictFailed,
  fixture: await readFile("/workspace/fixture", "utf8"), output: await readFile("/workspace/present", "utf8") }));
`);
  const { stdout } = await run("docker", ["run", "--rm", "--network", "none", "--mount",
    `type=bind,source=${directory},target=/proof,readonly`, "--entrypoint", "node", image!, "/proof/proof.mjs"], { timeout: 60_000 });
  expect(JSON.parse(stdout.trim())).toEqual({ present: [false, false, true], absent: true, strictFailed: true,
    fixture: "trusted verifier fixture", output: "agent output" });
}, 65_000);

test.skipIf(!image)("artifact exclusion filters directories and glob matches before restoring", async () => {
  const base = resolve(".scratch/workspace-transfer-exclusions");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "proof-"));
  await writeFile(join(directory, "workspace-transfer.mjs"), workspaceHelperSource);
  await writeFile(join(directory, "proof.mjs"), String.raw`
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
await mkdir("/workspace/app/node_modules", { recursive: true });
await mkdir("/workspace/app/src/__pycache__", { recursive: true });
for (const name of ["main.py", "src/keep.py", "src/cache.pyc", "node_modules/cache", "src/__pycache__/x"]) await writeFile("/workspace/app/" + name, name);
const spec = { kind: "artifacts", workdir: "/workspace", paths: ["/workspace/app"], excludes: { "/workspace/app": ["node_modules", "__pycache__", "*.pyc"] } };
const token = "12345678-1234-1234-1234-123456789abc";
const call = (...args) => execFileSync(process.execPath, ["/proof/workspace-transfer.mjs", ...args]);
call("export", token, JSON.stringify(spec));
const sha = createHash("sha256").update(await readFile("/opt/evaluator/transfers/" + token + "/state.tar")).digest("hex");
call("restore", token, sha);
console.log(JSON.stringify({ root: await readdir("/workspace/app"), src: await readdir("/workspace/app/src") }));
`);
  const { stdout } = await run("docker", ["run", "--rm", "--network", "none", "--mount",
    `type=bind,source=${directory},target=/proof,readonly`, "--entrypoint", "node", image!, "/proof/proof.mjs"], { timeout: 60_000 });
  expect(JSON.parse(stdout.trim())).toEqual({ root: ["main.py", "src"], src: ["keep.py"] });
}, 65_000);

test.skipIf(!image)("restore retains identical image fixtures without admitting changed or new unsafe links", async () => {
  const base = resolve(".scratch/workspace-transfer-regression");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "proof-"));
  await writeFile(join(directory, "workspace-transfer.mjs"), workspaceHelperSource);
  await writeFile(join(directory, "proof.mjs"), String.raw`
import { mkdir, rm, writeFile, symlink, readlink, lstat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const helper = "/proof/workspace-transfer.mjs";
const token = "12345678-abcd";
const call = (...args) => execFileSync("node", [helper, ...args], { stdio: "inherit" });
const setup = async () => {
  await rm("/workspace", { recursive: true, force: true });
  await mkdir("/workspace/nested", { recursive: true });
  await writeFile("/workspace/target", "fixture");
  await symlink("../target", "/workspace/nested/unchanged");
  await symlink("/etc/passwd", "/workspace/original-absolute");
  await symlink("../target", "/workspace/nested/changed");
  await symlink("../target", "/workspace/nested/deleted");
  await symlink("target", "/workspace/safe");
};
await setup();
await rm("/workspace/nested/changed");
await symlink("/proc/version", "/workspace/nested/changed");
await rm("/workspace/nested/deleted");
await symlink("/etc/passwd", "/workspace/new-absolute");
await writeFile("/workspace/analysis.json", "{}");
call("init", token);
call("export", token, JSON.stringify({ kind: "workspace-archive", workdir: "/workspace", extraPaths: [] }));
const archive = "/opt/evaluator/transfers/" + token + "/state.tar";
const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
await setup();
call("restore", token, sha);
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
console.log(JSON.stringify({
  unchanged: await readlink("/workspace/nested/unchanged"),
  originalAbsolute: await readlink("/workspace/original-absolute"),
  safe: await readlink("/workspace/safe"),
  changed: await exists("/workspace/nested/changed"),
  deleted: await exists("/workspace/nested/deleted"),
  newAbsolute: await exists("/workspace/new-absolute"),
  report: await exists("/workspace/analysis.json")
}));
`);
  const { stdout } = await run("docker", ["run", "--rm", "--network", "none", "--mount",
    `type=bind,source=${directory},target=/proof,readonly`, "--entrypoint", "node", image!, "/proof/proof.mjs"], { timeout: 60_000 });
  expect(JSON.parse(stdout.trim())).toEqual({
    unchanged: "../target", originalAbsolute: "/etc/passwd", safe: "target",
    changed: false, deleted: false, newAbsolute: false, report: true,
  });
}, 65_000);
