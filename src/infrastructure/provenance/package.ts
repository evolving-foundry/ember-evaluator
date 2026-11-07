import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;


export async function verifyPackageDirectory(root: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(root, "package-provenance.json"), "utf8")) as {
    schemaVersion?: unknown;
    algorithm?: unknown;
    files?: Record<string, unknown>;
    digest?: unknown;
  };
  if (
    manifest.schemaVersion !== 1 ||
    manifest.algorithm !== "sha256" ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw new Error("Invalid package provenance manifest");
  const inventory: string[] = [];
  async function scan(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error("Package inventory cannot contain symlinks");
      if (entry.isDirectory()) await scan(join(directory, entry.name), relative + "/");
      else if (/(?:\.(?:m?js|json|py|txt|ya?ml)$|(?:^|\/)Dockerfile$)/u.test(relative) && relative !== "package-provenance.json")
        inventory.push(relative);
    }
  }
  await scan(root, "");
  inventory.sort();
  if (!inventory.length || JSON.stringify(inventory) !== JSON.stringify(Object.keys(manifest.files).sort()))
    throw new Error("Package provenance inventory mismatch");
  const files: Record<string, string> = {};
  for (const relative of inventory) {
    const digest = hash(await readFile(join(root, relative)));
    if (digest !== manifest.files[relative]) throw new Error(`Package asset digest mismatch: ${relative}`);
    files[relative] = digest;
  }
  const digest = hash(JSON.stringify({ schemaVersion: 1, algorithm: "sha256", files }));
  if (digest !== manifest.digest) throw new Error("Package aggregate digest mismatch");
  return digest;
}

/** Verify at run bootstrap and Ray startup; do not cache across deployments. */
export async function loadPackageDigest(): Promise<string> {
  const local = new URL("../../", import.meta.url);
  // Source execution verifies its built distributable; installed execution verifies itself.
  const root = local.pathname.replaceAll("\\", "/").endsWith("/src/") ? new URL("../../../dist/", import.meta.url) : local;
  return await verifyPackageDirectory(fileURLToPath(root));
}
