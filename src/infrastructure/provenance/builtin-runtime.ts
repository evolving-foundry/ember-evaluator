import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";



type Provenance = {
  schemaVersion: 1;
  algorithm: "sha256";
  files: Record<string, string>;
  digest: string;
};

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
let cached: Promise<string> | undefined;

function hash(bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function aggregate(files: Record<string, string>): string {
  return hash(JSON.stringify({ schemaVersion: 1, algorithm: "sha256", files }));
}

async function readProvenance(url: URL): Promise<string> {
  const value = JSON.parse(await readFile(url, "utf8")) as Partial<Provenance>;
  if (
    value.schemaVersion !== 1 ||
    value.algorithm !== "sha256" ||
    value.files === null ||
    typeof value.files !== "object" ||
    Array.isArray(value.files) ||
    typeof value.digest !== "string" ||
    !DIGEST.test(value.digest)
  )
    throw new TypeError("Invalid builtin runtime provenance manifest");
  const root = new URL("./", url);
  const distributed = (await readdir(root)).filter(name => name === "runtime-lock.json" || name === "runtime-package.json" || name === "model-defaults.json" || name.endsWith(".js")).sort();
  const recorded = Object.keys(value.files).sort();
  if (recorded.length === 0 || JSON.stringify(recorded) !== JSON.stringify(distributed))
    throw new TypeError("Builtin runtime provenance inventory differs from distributed assets");
  const files: Record<string, string> = {};
  for (const name of recorded) {
    const expected = value.files[name];
    if (
      !/^[a-zA-Z0-9._-]+$/u.test(name) ||
      name === "builtin-provenance.json" ||
      typeof expected !== "string" ||
      !DIGEST.test(expected)
    ) {
      throw new TypeError("Invalid builtin runtime provenance entry");
    }
    const actual = hash(await readFile(new URL(name, root)));
    if (actual !== expected) throw new TypeError(`Builtin runtime asset digest differs: ${name}`);
    files[name] = actual;
  }
  const digest = aggregate(files);
  if (digest !== value.digest) throw new TypeError("Builtin runtime aggregate digest differs");
  return digest;
}

/** Read and verify the one distribution lock shared by source and packaged bootstrap. */
export function loadBuiltinRuntimeDigest(): Promise<string> {
  return (cached ??= (async () => {
    const candidates = [
      new URL("../../runtimes/pi/builtin-provenance.json", import.meta.url),
      new URL("../../../dist/runtimes/pi/builtin-provenance.json", import.meta.url),
    ];
    for (const candidate of candidates) {
      try {
        return await readProvenance(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error("Builtin runtime provenance is missing; run pnpm build before bootstrap");
  })());
}
