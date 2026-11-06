import "../fixtures/network-fetch.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { HttpZipJsonSource } from "../../src/infrastructure/datasets/sources/http/zip-json-source.js";
import { readZipJson } from "../../src/infrastructure/datasets/input-readers/zip-json.js";
import { LocalZipJsonSource } from "../../src/infrastructure/datasets/sources/local/zip-json-source.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "zip-json-source-")); roots.push(path); return path; }

function zip(content: string, name: string, method = 8): Buffer {
  const raw = Buffer.from(content), filename = Buffer.from(name);
  const payload = method === 8 ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + payload.length, 16);
  return Buffer.concat([local, filename, payload, central, filename, end]);
}

test("local ZIP data is read without a request and file changes are rejected", async () => {
  const directory = await root(), path = join(directory, "drop.zip");
  await writeFile(path, zip('{"passage":{"qa_pairs":[]}}', "drop_dataset/dev.json"));
  const fetch = vi.fn(async () => { throw new Error("Unexpected remote request"); }); vi.stubGlobal("fetch", fetch);
  const source = new LocalZipJsonSource(path, { test: "drop_dataset/dev.json" });
  const signal = new AbortController().signal;
  const lock = await source.resolve(null, signal);
  expect((await source.rows(lock, "test", signal)[Symbol.asyncIterator]().next()).value).toEqual({ passage: { qa_pairs: [] } });
  expect(fetch).not.toHaveBeenCalled();
  await writeFile(path, zip('{"changed":true}', "drop_dataset/dev.json"));
  await expect(source.rows(lock, "test", signal)[Symbol.asyncIterator]().next()).rejects.toThrow(/changed/);
});

test.each([0, 8])("locked ZIP JSON source resumes from verified cache (method %s)", async method => {
  const directory = await root();
  const bytes = zip('{"passage":{"qa_pairs":[{"answer":{"spans":["Alice","Bob"]}}]}}', "dataset/dev.json", method);
  const definition = { url: "https://fixture.invalid/dataset.zip", sha256: createHash("sha256").update(bytes).digest("hex"), selections: { test: "dataset/dev.json" } };
  const fetch = vi.fn(async () => new Response(bytes)); vi.stubGlobal("fetch", fetch);
  const source = new HttpZipJsonSource(directory, definition), signal = new AbortController().signal;
  const lock = await source.resolve(null, signal);
  expect(lock.files).toEqual([{ path: "dataset.zip", origin: definition.url, sha256: definition.sha256 }]);
  const rows = [];
  for await (const row of source.rows(lock, "test", signal)) rows.push(row);
  expect(rows).toEqual([{ passage: { qa_pairs: [{ answer: { spans: ["Alice", "Bob"] } }] } }]);
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async () => { throw new Error("Unexpected network request"); });
  expect(await new HttpZipJsonSource(directory, definition).resolve(lock, signal)).toEqual(lock);
  await expect(source.resolve({ ...lock, revision: "changed" }, signal)).rejects.toThrow(/new run/);
  await expect(source.rows(lock, "missing", signal)[Symbol.asyncIterator]().next()).rejects.toThrow(/Unknown/);
  await expect(new HttpZipJsonSource(directory, { ...definition, selections: { test: "different.json" } }).resolve(lock, signal)).rejects.toThrow(/new run/);
});

test("ZIP reader rejects corrupt checksums, missing entries and invalid data", async () => {
  const directory = await root(), path = join(directory, "dataset.zip"), signal = new AbortController().signal;
  const bytes = zip('{"valid":true}', "dev.json", 0);
  await writeFile(path, bytes);
  await expect(readZipJson(path, "missing.json", signal)).rejects.toThrow(/missing/);
  bytes[30 + Buffer.byteLength("dev.json")] = 0;
  await writeFile(path, bytes);
  await expect(readZipJson(path, "dev.json", signal)).rejects.toThrow(/checksum/);
  await writeFile(path, "invalid");
  await expect(readZipJson(path, "dev.json", signal)).rejects.toThrow(/ZIP/);
});
