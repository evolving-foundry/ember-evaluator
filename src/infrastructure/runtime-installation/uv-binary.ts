import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { PINNED_NODE_IMAGE } from "../containers/runtime-contract.js";

const execFileAsync = promisify(execFile);

/** Harness-specific error factory so each adapter keeps its own error type. */
export type UvBinaryFailure = (message: string) => Error;

export async function probeVersion(executable: string, args: string[], signal: AbortSignal): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(executable, args, { timeout: 15_000, maxBuffer: 64 * 1024, signal });
    const version = stdout.trim();
    return version === "" ? null : version;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/**
 * The uv binary is injected into the solver image and executed inside the
 * build, so it must be a linux/x86_64 executable regardless of the host
 * platform (the Docker target is pinned to linux/x64; a static uv build runs
 * on any glibc/musl base).
 */
export async function assertLinuxX86_64Binary(path: string, signal: AbortSignal, fail: UvBinaryFailure): Promise<void> {
  const handle = await open(path, "r").catch(error => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw fail(`uv binary disappeared: ${path}`);
    throw error;
  });
  try {
    signal.throwIfAborted();
    const { buffer } = await handle.read(Buffer.alloc(20), 0, 20, 0);
    const elf = buffer.subarray(0, 20);
    const isElf =
      elf[0] === 0x7f && elf[1] === 0x45 && elf[2] === 0x4c && elf[3] === 0x46 &&
      elf[4] === 2 && elf[5] === 1;
    const machine = (elf[18] ?? 0) | ((elf[19] ?? 0) << 8);
    if (!isElf || machine !== 0x3e)
      throw fail(
        `the resolved uv binary ${path} is not a linux/x86_64 executable; docker bundles need a static uv build (e.g. uv-installed x86_64-unknown-linux-gnu/musl), not the host platform binary`,
      );
  } finally {
    await handle.close();
  }
}

/**
 * Resolve the uv binary docker builds inject into the solver image:
 * `UV_BIN` first, then `uv` on PATH. The resolved file must be a linux/x86_64
 * executable, so a Windows or macOS host binary is rejected here instead of
 * failing later inside the image build.
 */
export async function resolveLinuxUvBinary(
  signal: AbortSignal,
  fail: UvBinaryFailure,
): Promise<{ path: string; version: string }> {
  const candidates = [process.env.UV_BIN, "uv"].filter((value): value is string => value !== undefined && value !== "");
  for (const candidate of [...new Set(candidates)]) {
    let version = await probeVersion(candidate, ["--version"], signal);
    // A Windows host cannot execute the Linux binary it will inject into Docker.
    // Probe an explicitly supplied ELF in the same pinned Linux runtime instead.
    if (version === null && process.platform === "win32" && isAbsolute(candidate)) {
      await assertLinuxX86_64Binary(candidate, signal, fail);
      version = await probeVersion("docker", [
        "run", "--rm", "--pull=never", "--network=none", "--platform=linux/amd64",
        "--mount", `type=bind,source=${resolve(candidate)},target=/uv,readonly`,
        "--entrypoint", "/uv", PINNED_NODE_IMAGE, "--version",
      ], signal);
    }
    if (version === null) continue;
    let path: string | undefined;
    if (isAbsolute(candidate) || candidate.includes("/")) {
      path = candidate;
    } else {
      // Re-derive the PATH entry the successful probe used so the injected
      // file is the binary that actually executes.
      for (const entry of (process.env.PATH ?? "")
        .split(delimiter)
        .map(item => item.replace(/^"|"$/gu, ""))
        .filter(Boolean)) {
        const full = `${entry}/${candidate}`;
        if ((await probeVersion(full, ["--version"], signal)) !== null) {
          path = full;
          break;
        }
      }
      path ??= candidate;
    }
    await assertLinuxX86_64Binary(path, signal, fail);
    return { path, version: /^uv\s+(\S+)/u.exec(version)?.[1] ?? "unknown" };
  }
  throw fail(
    "docker bundles require uv on the host (UV_BIN or PATH) to inject the binary into the solver image; install uv or set UV_BIN",
  );
}
