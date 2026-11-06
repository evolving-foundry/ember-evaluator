import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";

const EXCLUDED_DIRECTORIES = new Set([".git", ".venv", "node_modules", "vendor", "__pycache__"]);
const INTEGRITY_FILE = "bundle.integrity.json";

type IntegrityDocument = { schemaVersion: 1; algorithm: "sha256"; digest: string; files: Record<string, string> };

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function paths(root: string, directory = root): Promise<string[]> {
  const output: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === INTEGRITY_FILE || entry.name === ".DS_Store") continue;
    const path = join(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Pi bundle contains a symbolic link: ${relative(root, path)}`);
    if (info.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) output.push(...await paths(root, path));
      continue;
    }
    if (!info.isFile()) throw new Error(`Pi bundle contains a special file: ${relative(root, path)}`);
    output.push(relative(root, path).replaceAll("\\", "/"));
  }
  return output;
}

function parseDocument(value: unknown): IntegrityDocument {
  const root = expectRecord(value, "Pi bundle integrity");
  rejectUnknown(root, ["schemaVersion", "algorithm", "digest", "files"], "Pi bundle integrity");
  if (root.schemaVersion !== 1) throw new TypeError("Pi bundle integrity schemaVersion must be 1");
  if (root.algorithm !== "sha256") throw new TypeError("Pi bundle integrity algorithm must be sha256");
  const files = expectRecord(root.files, "Pi bundle integrity.files");
  const parsed: Record<string, string> = {};
  for (const [path, digest] of Object.entries(files)) {
    if (path === "" || path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === ".."))
      throw new TypeError(`Pi bundle integrity contains an unsafe path: ${path}`);
    parsed[path] = expectNonEmptyString(digest, `Pi bundle integrity.files.${path}`);
  }
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    digest: expectNonEmptyString(root.digest, "Pi bundle integrity.digest"),
    files: parsed,
  };
}

export async function verifyPiBundleIntegrity(bundleRoot: string): Promise<string> {
  const document = parseDocument(JSON.parse(await readFile(join(bundleRoot, INTEGRITY_FILE), "utf8")) as unknown);
  const actualPaths = await paths(bundleRoot);
  const expectedPaths = Object.keys(document.files);
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) {
    throw new Error("Pi bundle integrity file list is stale; rebuild the bundle and refresh bundle.integrity.json");
  }
  const tree = createHash("sha256");
  for (const path of actualPaths) {
    const digest = sha256(await readFile(join(bundleRoot, path)));
    if (document.files[path] !== digest) throw new Error(`Pi bundle integrity mismatch: ${path}`);
    tree.update(path);
    tree.update("\0");
    tree.update(digest);
    tree.update("\n");
  }
  const digest = `sha256:${tree.digest("hex")}`;
  if (document.digest !== digest) throw new Error("Pi bundle integrity tree digest is stale");
  return digest;
}
