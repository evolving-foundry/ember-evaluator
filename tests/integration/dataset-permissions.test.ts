import "../fixtures/network-fetch.js";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Header } from "tar";
import { afterEach, expect, test, vi } from "vitest";
import { materializeDirectory } from "../../src/infrastructure/datasets/sources/directory.js";
import { readDirectoryModes } from "../../src/infrastructure/filesystem/directory-modes.js";
import { writeGitFile } from "../../src/infrastructure/datasets/sources/github/files.js";

const roots: string[] = [];
const signal = () => new AbortController().signal;
const mode = async (path: string) => (await lstat(path)).mode & 0o777;
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dataset-permissions-"));
  roots.push(root);
  const bytes = Buffer.from("#!/bin/sh\nprintf ready\n");
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("/git/trees/")
    ? new Response(JSON.stringify({ truncated: false, tree: [
      { path: "tasks/a/data/model.urdf", mode: "100644", type: "blob", sha },
      { path: "tasks/a/run.sh", mode: "100755", type: "blob", sha },
    ] })) : new Response(bytes)));
  return { root, source: { kind: "github" as const, repository: "fixture/bench", revision: "a".repeat(40), path: "." } };
}

// These tests run in Vitest's isolated fork. Always restore umask before leaving
// the test; changing it in a worker thread is intentionally unsupported by Node.
test.skipIf(process.platform === "win32")("strict umask preserves Git data and executable modes without opening the cache envelope", async () => {
  const { root, source } = await fixture();
  const previous = process.umask(0o077);
  try {
    const snapshot = await materializeDirectory(source, join(root, "cache"), signal());
    expect(await mode(join(snapshot.directory, "tasks/a/data/model.urdf"))).toBe(0o644);
    expect(await mode(join(snapshot.directory, "tasks/a/run.sh"))).toBe(0o755);
    expect(await mode(join(snapshot.directory, "tasks/a/data"))).toBe(0o755);
    expect(await mode(snapshot.directory)).toBe(0o700);
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(join(root, "cache/objects")))
      expect(await mode(join(root, "cache/objects", entry))).toBe(0o600);
    expect(process.umask()).toBe(0o077);
  } finally { process.umask(previous); }
});

test.skipIf(process.platform === "win32")("verified cache reuse repairs legacy modes but rejects changed content", async () => {
  const { root, source } = await fixture();
  const cache = join(root, "cache");
  const snapshot = await materializeDirectory(source, cache, signal());
  const data = join(snapshot.directory, "tasks/a/data/model.urdf");
  const script = join(snapshot.directory, "tasks/a/run.sh");
  await chmod(data, 0o600); await chmod(script, 0o700);
  await chmod(join(snapshot.directory, "tasks/a/data"), 0o700);
  const previous = process.umask(0o077);
  try {
    const repaired = await materializeDirectory(source, cache, signal());
    expect(repaired.revision).toBe(snapshot.revision);
    expect(await mode(data)).toBe(0o644);
    expect(await mode(script)).toBe(0o755);
    expect(await mode(join(snapshot.directory, "tasks/a/data"))).toBe(0o755);
    expect(await mode(snapshot.directory)).toBe(0o700);
    await writeFile(data, "changed source"); await chmod(data, 0o600);
    await expect(materializeDirectory(source, cache, signal())).rejects.toThrow(/differs/);
    expect(await mode(data)).toBe(0o600);
  } finally { process.umask(previous); }
});

test.skipIf(process.platform === "win32")("archive modes survive strict umask and cache reuse without Git-style normalization", async () => {
  const { root } = await fixture();
  function entry(path: string, type: "File" | "Directory", mode: number, content = "") {
    const data = Buffer.from(content);
    const header = new Header({ path, type, mode, size: data.length }); header.encode();
    if (!header.block) throw new Error("Missing tar header");
    return Buffer.concat([header.block, data, Buffer.alloc((512 - data.length % 512) % 512)]);
  }
  const bytes = Buffer.concat([
    entry("dataset/assets", "Directory", 0o750),
    entry("dataset/assets/data.txt", "File", 0o640, "data"),
    entry("dataset/bin/run.sh", "File", 0o751, "#!/bin/sh\n"),
    Buffer.alloc(1024),
  ]);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
  const source = { kind: "archive" as const, url: "https://fixture.invalid/data.tar", sha256: createHash("sha256").update(bytes).digest("hex"), root: "dataset" };
  const previous = process.umask(0o077);
  try {
    const snapshot = await materializeDirectory(source, join(root, "cache"), signal());
    const data = join(snapshot.directory, "assets/data.txt");
    expect(await mode(data)).toBe(0o640);
    expect(await mode(join(snapshot.directory, "assets"))).toBe(0o750);
    expect(await mode(join(snapshot.directory, "bin/run.sh"))).toBe(0o751);
    expect(await mode(join(snapshot.directory, "bin"))).toBe(0o755);
    await chmod(data, 0o600);
    await materializeDirectory(source, join(root, "cache"), signal());
    expect(await mode(data)).toBe(0o640);
    expect(await readFile(data, "utf8")).toBe("data");
  } finally { process.umask(previous); }
});

test.skipIf(process.platform === "win32")("local sources retain user permissions", async () => {
  const { root } = await fixture();
  const directory = join(root, "local"); await mkdir(directory, { mode: 0o750 });
  await writeFile(join(directory, "private.json"), "{}", { mode: 0o600 });
  await writeFile(join(directory, "script.sh"), "#!/bin/sh\n", { mode: 0o710 });
  const before = await readDirectoryModes(directory, signal());
  await materializeDirectory({ kind: "local", path: directory }, join(root, "unused-cache"), signal());
  expect(await readDirectoryModes(directory, signal())).toEqual(before);
});

test("Git file writes honor cancellation and reject escaping paths", async () => {
  const { root } = await fixture();
  await expect(writeGitFile(root, "../outside", Buffer.from("x"), false, signal())).rejects.toThrow(/path/i);
  const controller = new AbortController(); controller.abort();
  await expect(writeGitFile(root, "data/file", Buffer.from("x"), false, controller.signal)).rejects.toThrow();
});
