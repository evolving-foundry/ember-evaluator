import type { JsonValue } from "../../../core/contracts/task.js";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint")
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJson(child)]));
  throw new TypeError("Dataset contains a non-JSON value");
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closedQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else field += char;
    } else if (char === "," || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      closedQuote = false;
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text[i + 1] === "\n") i++;
      }
    } else if (closedQuote) throw new TypeError("Unexpected text after CSV closing quote");
    else if (char === '"') {
      if (field) throw new TypeError("Unexpected CSV quote");
      quoted = true;
    } else field += char;
  }
  if (quoted) throw new TypeError("Unclosed CSV quote");
  if (field || row.length || closedQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export async function* readRows(path: string, format: "jsonl" | "csv" | "parquet"): AsyncIterable<JsonValue> {
  if (format === "jsonl") {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let number = 0;
    try {
      for await (let line of lines) {
        number++;
        if (number === 1) line = line.replace(/^\uFEFF/, "");
        try {
          yield toJson(JSON.parse(line));
        } catch (error) {
          throw new TypeError(`Invalid JSONL row ${number}`, { cause: error });
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } else if (format === "csv") {
    const rows = csvRows((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
    const headers = rows.shift();
    if (!headers || headers.some(header => !header) || new Set(headers).size !== headers.length)
      throw new TypeError("Invalid CSV header");
    for (const row of rows) {
      if (row.length !== headers.length) throw new TypeError("CSV column count does not match header");
      yield Object.fromEntries(headers.map((header, index) => [header, row[index]!]));
    }
  } else if (format === "parquet") {
    const file = await asyncBufferFromFile(path);
    for (const row of await parquetReadObjects({ file })) yield toJson(row);
  } else throw new TypeError(`Unsupported dataset format: ${String(format)}`);
}
