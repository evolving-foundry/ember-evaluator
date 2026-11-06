import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkedPath, inspectFile, verifyFileManifest } from "../../core/artifacts/artifacts.js";
import {
  TransferError,
  createReceipt,
  transferId,
  uploadDigest,
  validateReceipt,
  validateTransferPath,
  validateUploadManifest,
  type UploadManifest,
  type UploadReceipt,
} from "./protocol.js";

export type AcceptUpload = (manifest: UploadManifest, evidenceRoot: string) => Promise<boolean>;
function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function atomicJson(path: string, value: unknown) {
  const temporary = join(dirname(path), `.transfer-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function directory(root: string, relative: string): Promise<string> {
  let current = root;
  if ((await lstat(root)).isSymbolicLink()) throw new TransferError("TRANSFER_UNSAFE", "Receiver root is a symlink");
  for (const part of relative.split("/").filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new TransferError("TRANSFER_UNSAFE", "Receiver parent is unsafe");
  }
  return current;
}

/** One coordinator owns this directory; the run's writer lock guards publication. */
export class DirectoryReceiver {
  private readonly root: string;
  private readonly ready: Promise<void>;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    root: string,
    private readonly accept: AcceptUpload,
  ) {
    const absolute = resolve(root);
    this.root = absolute;
    this.ready = (async () => {
      await mkdir(absolute, { recursive: true });
      if ((await lstat(absolute)).isSymbolicLink())
        throw new TransferError("TRANSFER_UNSAFE", "Receiver root is a symlink");
    })();
  }
  private async serialized<T>(id: string, action: () => Promise<T>): Promise<T> {
    transferId(id);
    await this.ready;
    const pending = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.queues.set(id, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(id) === pending) this.queues.delete(id);
    }
  }
  private async manifest(id: string): Promise<UploadManifest> {
    let file: string;
    try {
      file = await checkedPath(this.root, `${id}/manifest.json`);
    } catch (error) {
      if (absent(error)) throw new TransferError("TRANSFER_NOT_FOUND", "Begin the upload first", 404);
      throw error;
    }
    const manifest = validateUploadManifest(JSON.parse(await readFile(file, "utf8")));
    if (manifest.transferId !== id)
      throw new TransferError("TRANSFER_CHECKSUM_MISMATCH", "Staged transfer identity differs", 409);
    return manifest;
  }
  private async receipt(manifest: UploadManifest): Promise<UploadReceipt | null> {
    let path: string;
    try {
      path = await checkedPath(this.root, `${manifest.transferId}/receipt.json`);
    } catch (error) {
      if (absent(error)) return null;
      throw error;
    }
    return validateReceipt(JSON.parse(await readFile(path, "utf8")), manifest);
  }
  private async missing(manifest: UploadManifest): Promise<string[]> {
    const root = await checkedPath(this.root, `${manifest.transferId}/evidence`);
    const paths: string[] = [];
    for (const entry of manifest.files) {
      try {
        const actual = await inspectFile(root, entry.path);
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) paths.push(entry.path);
      } catch (error) {
        if (absent(error)) paths.push(entry.path);
        else throw error;
      }
    }
    return paths;
  }
  async beginUpload(input: unknown): Promise<{ missingPaths: string[]; receipt: UploadReceipt | null }> {
    const manifest = validateUploadManifest(input);
    return this.serialized(manifest.transferId, async () => {
      const root = await directory(this.root, manifest.transferId);
      let old: UploadManifest | null = null;
      try {
        old = await this.manifest(manifest.transferId);
      } catch (error) {
        if (!(error instanceof TransferError) || error.code !== "TRANSFER_NOT_FOUND") throw error;
      }
      if (old && uploadDigest(old) !== uploadDigest(manifest))
        throw new TransferError("TRANSFER_CONFLICT", "Transfer ID content conflict", 409);
      if (!old) {
        if ((await readdir(root)).some(name => !/^\.transfer-.*\.tmp$/u.test(name)))
          throw new TransferError("TRANSFER_CHECKSUM_MISMATCH", "Orphan staged files require inspection", 409);
        await atomicJson(join(root, "manifest.json"), manifest);
      }
      await directory(this.root, `${manifest.transferId}/evidence`);
      const receipt = await this.receipt(manifest);
      return { missingPaths: receipt ? [] : await this.missing(manifest), receipt };
    });
  }
  async uploadFile(id: string, path: string, bytes: AsyncIterable<Uint8Array>): Promise<void> {
    validateTransferPath(path);
    return this.serialized(id, async () => {
      const manifest = await this.manifest(id);
      if (await this.receipt(manifest))
        throw new TransferError("TRANSFER_CONFLICT", "Upload already has a receipt", 409);
      const expected = manifest.files.find(entry => entry.path === path);
      if (!expected) throw new TransferError("TRANSFER_UNSAFE", "File is not in the upload manifest", 400);
      const root = await directory(this.root, `${id}/evidence/${path.split("/").slice(0, -1).join("/")}`);
      const target = join(root, path.split("/").at(-1)!);
      try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new TransferError("TRANSFER_UNSAFE", "Upload target is unsafe");
      } catch (error) {
        if (!absent(error)) throw error;
      }
      const temporary = join(this.root, id, `.transfer-${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256");
      let size = 0;
      try {
        try {
          for await (const chunk of bytes) {
            size += chunk.byteLength;
            if (size > expected.size)
              throw new TransferError("TRANSFER_CHECKSUM_MISMATCH", "Uploaded file exceeds declared size", 422);
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          if (size !== expected.size || hash.digest("hex") !== expected.sha256)
            throw new TransferError("TRANSFER_CHECKSUM_MISMATCH", "Uploaded file size or checksum differs", 422);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
  async commitUpload(id: string): Promise<UploadReceipt> {
    return this.serialized(id, async () => {
      const manifest = await this.manifest(id);
      const old = await this.receipt(manifest);
      if (old) return old;
      if ((await this.missing(manifest)).length)
        throw new TransferError("TRANSFER_FAILED", "Upload has missing files", 409);
      const root = await checkedPath(this.root, `${id}/evidence`);
      await verifyFileManifest(root, { files: manifest.files, missing: manifest.missing });
      const accepted = await this.accept(structuredClone(manifest), root);
      const receipt = createReceipt(manifest, accepted);
      await atomicJson(join(this.root, id, "receipt.json"), receipt);
      return receipt;
    });
  }
}
