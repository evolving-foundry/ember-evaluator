import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * msprof 采集缓存（kernel 原版 msprof_cache.py 的 TS 语义移植）：
 * 同 kernel 文件字节 + 设备 id 幂等不重采（每次省约 40s 真机时间）。
 * key 算法与 py 版逐字节兼容（sha256(kernel bytes || JSON.stringify(deviceId))），
 * 历史条目继续命中。
 */

const MAX_ENTRIES = 512;

export interface CachedMsProfResult {
  metrics: Record<string, unknown>;
  metricsRecords: Record<string, unknown>[] | null;
  profileDir: string;
  originProfileDir: string;
  metadata: Record<string, unknown>;
  hits: number;
}

interface CacheEntry {
  key: string;
  hits: number;
  created_ts: unknown;
  metrics: Record<string, unknown>;
  metrics_records?: Record<string, unknown>[] | null;
  profile_dir?: string;
  origin_profile_dir?: string;
  metadata?: Record<string, unknown>;
}

function entryPath(cacheDir: string, keyHash: string): string {
  return join(cacheDir, `${keyHash}.json`);
}

const isHexKey = (name: string): boolean => /^[0-9a-fA-F]{64}$/.test(name);

/** py 版 _backup_profile_dir 语义：首次命中/落缓存时把 profile 目录备份进缓存区。 */
async function backupProfileDir(cacheDir: string, keyHash: string, profileDir: string): Promise<string> {
  if (profileDir === "" || !existsSync(profileDir)) return profileDir;
  const dest = join(cacheDir, "profiles", keyHash);
  try {
    await rm(dest, { recursive: true, force: true });
    await mkdir(dirname(dest), { recursive: true });
    await cp(profileDir, dest, { recursive: true });
    return dest;
  } catch {
    // 备份失败不致命：保留原 profile_dir（与原版一致）。
    return profileDir;
  }
}

async function cacheRoot(cacheDir?: string): Promise<string | null> {
  if (process.env["KA_MSPROF_CACHE_DISABLED"] === "1") return null;
  if (cacheDir !== undefined && cacheDir !== "") return cacheDir;
  if (process.env["KA_MSPROF_CACHE_DIR"]) return process.env["KA_MSPROF_CACHE_DIR"];
  return join(homedir(), ".kernel_agent", "msprof_cache");
}

export class MsProfCache {
  private readonly dir: string;

  private constructor(dir: string) {
    this.dir = dir;
  }

  /** 构建缓存；缓存被禁用时返回 null。device 缺失时与原版一致地禁用（key 不完整宁可重采）。 */
  static async open(deviceId: string | undefined, cacheDir?: string, log?: (line: string) => void): Promise<MsProfCache | null> {
    const root = await cacheRoot(cacheDir);
    if (root === null) return null;
    if (deviceId === undefined || deviceId === "") {
      log?.(`MSProfCache skipped: no ASCEND_RT_VISIBLE_DEVICES device id`);
      return null;
    }
    await mkdir(root, { recursive: true });
    return new MsProfCache(root);
  }

  private async keyHash(kernelBytes: Buffer, deviceId: string): Promise<string> {
    return createHash("sha256").update(kernelBytes).update(JSON.stringify(deviceId)).digest("hex");
  }

  async get(kernelBytes: Buffer, deviceId: string | undefined, log?: (line: string) => void): Promise<CachedMsProfResult | null> {
    if (deviceId === undefined) return null;
    const hash = await this.keyHash(kernelBytes, deviceId);
    const path = entryPath(this.dir, hash);
    if (!existsSync(path)) return null;
    let data: CacheEntry;
    try {
      data = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
    } catch (error) {
      log?.(`MSProfCache entry corrupted (${hash}): ${String(error)}`);
      return null;
    }
    const hitsBefore = Number(data.hits ?? 0) || 0;
    data.hits = hitsBefore + 1;
    let profileDir = String(data.profile_dir ?? "");
    if (data.origin_profile_dir === undefined && profileDir !== "") {
      const origin = profileDir;
      const backed = await backupProfileDir(this.dir, hash, profileDir);
      data.origin_profile_dir = origin;
      data.profile_dir = backed;
      profileDir = backed;
    }
    try {
      await writeFile(path, JSON.stringify(data, null, 2), "utf8");
    } catch (error) {
      log?.(`MSProfCache entry write failed (ignored): ${String(error)}`);
    }
    log?.(`MSProfCache HIT ${path} hits=${hitsBefore + 1}`);
    return {
      metrics: data.metrics ?? {},
      metricsRecords: data.metrics_records ?? null,
      profileDir,
      originProfileDir: String(data.origin_profile_dir ?? ""),
      metadata: data.metadata ?? {},
      hits: hitsBefore + 1,
    };
  }

  async put(kernelBytes: Buffer, deviceId: string | undefined, profileDir: string,
    metrics: Record<string, unknown>, metadata: Record<string, unknown>,
    metricsRecords: Record<string, unknown>[] | null): Promise<void> {
    if (deviceId === undefined) return;
    const hash = await this.keyHash(kernelBytes, deviceId);
    const path = entryPath(this.dir, hash);
    let existingHits = 0;
    if (existsSync(path)) {
      try {
        existingHits = Number((JSON.parse(await readFile(path, "utf8")) as CacheEntry).hits ?? 0) || 0;
      } catch {
        existingHits = 0;
      }
    }
    const backedDir = await backupProfileDir(this.dir, hash, profileDir);
    const data: CacheEntry = {
      key: hash, hits: existingHits, created_ts: null, metrics,
      metrics_records: metricsRecords, profile_dir: backedDir,
      origin_profile_dir: profileDir, metadata,
    };
    try {
      const tmp = `${path}.tmp.${process.pid}`;
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      await rename(tmp, path);
      await this.prune();
    } catch (error) {
      // 缓存写失败不影响本次剖析结果（与原版一致）。
      console.warn(`MSProfCache store failed (ignored): ${String(error)}`);
    }
  }

  /** 超容量时按 mtime 淘汰最旧条目及其 profile 备份目录。 */
  private async prune(): Promise<void> {
    const names = (await readdir(this.dir)).filter(isHexKey);
    if (names.length <= MAX_ENTRIES) return;
    const entries = await Promise.all(names.map(async name => ({
      name, mtime: (await stat(join(this.dir, name))).mtimeMs,
    })));
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(MAX_ENTRIES)) {
      try {
        await rm(join(this.dir, stale.name));
        await rm(join(this.dir, "profiles", stale.name), { recursive: true, force: true });
      } catch {
        // 淘汰失败留给下次。
      }
    }
  }
}
