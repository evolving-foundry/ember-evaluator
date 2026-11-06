import { readFile } from "node:fs/promises";
import { crc32, inflateRawSync } from "node:zlib";
import type { JsonValue } from "../../../core/contracts/task.js";

/** Read selected ZIP32 JSON entries in memory without writing archive paths to disk. */
export async function readZipJson(path: string, name: string, signal: AbortSignal): Promise<JsonValue> {
  const bytes = await readFile(path, { signal });
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0)
    throw new Error("Unsupported ZIP directory");
  const entries = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  if (entries === 0xffff || offset === 0xffff_ffff) throw new Error("ZIP64 is not supported");
  for (let index = 0; index < entries; index++) {
    signal.throwIfAborted();
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > end) throw new Error("Invalid ZIP directory size");
    const entryName = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (entryName === name) {
      const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
      const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
      const local = bytes.readUInt32LE(offset + 42);
      if ((flags & 1) || ![0, 8].includes(method) || size > 128 * 1024 * 1024 || local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50)
        throw new Error("Unsupported or oversized ZIP entry");
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + compressed > offset) throw new Error("Invalid ZIP data bounds");
      const payload = bytes.subarray(start, start + compressed);
      const content = method === 0 ? payload : inflateRawSync(payload, { maxOutputLength: 128 * 1024 * 1024 });
      if (content.length !== size || crc32(content) !== bytes.readUInt32LE(offset + 16)) throw new Error("ZIP entry checksum mismatch");
      signal.throwIfAborted();
      // JSON.parse produces JSON data; benchmark definitions validate its record schema.
      return JSON.parse(content.toString("utf8")) as JsonValue;
    }
    offset = next;
  }
  throw new Error(`ZIP JSON entry is missing: ${name}`);
}
