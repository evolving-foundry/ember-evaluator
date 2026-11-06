import type { ErrorCode } from "../../../core/errors/registry.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { TransferArtifact, TransferSpec } from "../../../core/contracts/environment.js";
import { PROCESS_HELPER, type DockerCommand } from "../../../infrastructure/containers/runtime-contract.js";
import { STATE_HELPER } from "../../../infrastructure/filesystem/workspace-transfer.js";

export class GitPatchError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "GitPatchError";
  }
}

/** Roots a restored patch must never touch; /logs stays allowed for artifacts. */
const PATCH_FORBIDDEN_ROOTS = [
  "/proc",
  "/sys",
  "/dev",
  "/opt/evaluator",
  "/opt/evaluator-agent",
  "/tests",
  "/solution",
];

export function validateGitPatchSpec(spec: TransferSpec, workdir: string): asserts spec is Extract<TransferSpec, { kind: "git-patch" }> {
  if (spec.kind !== "git-patch" || spec.workdir !== workdir)
    throw new GitPatchError("TRANSFER_UNSAFE", "Git patch transfer must describe this session's workdir");
  if (!/^[0-9a-f]{4,40}$/u.test(spec.baseCommit))
    throw new GitPatchError("TRANSFER_UNSAFE", `Unsafe Git base commit: ${spec.baseCommit}`);
  const target = spec.target;
  if (
    typeof target !== "string" ||
    !target.startsWith("/") ||
    target === "/" ||
    /[\\\0]/u.test(target) ||
    posix.normalize(target) !== target ||
    PATCH_FORBIDDEN_ROOTS.some(root => target === root || target.startsWith(`${root}/`))
  )
    throw new GitPatchError("TRANSFER_UNSAFE", `Unsafe patch target: ${target}`);
}

async function digest(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

type PatchSession = { id: string; workdir: string; command: DockerCommand };

async function discardContainerStage(session: PatchSession, token: string): Promise<void> {
  try {
    await session.command(["exec", session.id, "node", STATE_HELPER, "cleanup", token], {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The stage directory dies with the container; a failed best-effort sweep
    // must not mask the transfer outcome.
  }
}

async function containerRunning(session: PatchSession, signal: AbortSignal): Promise<boolean> {
  const state = JSON.parse(
    (await session.command(["inspect", session.id, "--format", "{{json .State}}"], { signal })).stdout,
  ) as { Running?: boolean; Paused?: boolean };
  if (state.Paused) throw new GitPatchError("ENV_CAPABILITY_UNSUPPORTED", `container ${session.id} is paused`);
  return state.Running === true;
}

/**
 * Export committed changes as a binary patch. Mirrors the official collect
 * semantics: `git diff --binary <baseCommit> HEAD` covers committed changes
 * only — uncommitted and untracked files never enter the patch.
 */
export async function exportGitPatch(
  session: PatchSession,
  spec: TransferSpec,
  target: string,
  signal: AbortSignal,
): Promise<TransferArtifact> {
  validateGitPatchSpec(spec, session.workdir);
  signal.throwIfAborted();
  const token = randomUUID();
  const staging = await mkdtemp(join(tmpdir(), "evaluator-patch-"));
  // A timed-out or cancelled solve stops its container; the committed work is
  // still verifiable, so it is restarted for the export and stopped again.
  let restart = false;
  if (!(await containerRunning(session, signal))) {
    await session.command(["start", session.id], { signal });
    restart = true;
  }
  try {
    const containerPatch = `/opt/evaluator/transfers/${token}/model.patch`;
    const attempt = async () => {
      await session.command(
        ["exec", session.id, "node", PROCESS_HELPER, "mkdir", "/opt/evaluator", containerPatch, "file"],
        { signal },
      );
      // The official collector marks foreign-owned checkouts safe before diffing.
      await session.command(["exec", session.id, "git", "config", "--global", "--add", "safe.directory", spec.workdir], {
        signal,
      });
      try {
        await session.command(
          [
            "exec",
            session.id,
            "git",
            "-C",
            spec.workdir,
            "diff",
            "--binary",
            "--output",
            containerPatch,
            spec.baseCommit,
            "HEAD",
          ],
          { signal },
        );
      } catch (cause) {
        throw new GitPatchError(
          "ARTIFACT_COLLECTION_INCOMPLETE",
          `git diff ${spec.baseCommit} HEAD failed in ${session.id}`,
          cause,
        );
      }
      await session.command(["cp", `${session.id}:${containerPatch}`, path], { signal });
    };
    const path = join(staging, "model.patch");
    try {
      await attempt();
    } catch (error) {
      // The abort handler of a just-timed-out solve may still be stopping the
      // container; settle, restart once and retry the export.
      if (restart || (await containerRunning(session, signal).catch(() => false))) throw error;
      await session.command(["start", session.id], { signal });
      restart = true;
      await attempt();
    }
    await discardContainerStage(session, token);
    const sha256 = await digest(path, signal);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(path, target);
    return { path: target, sha256, spec: structuredClone(spec) };
  } finally {
    if (restart)
      await session.command(["stop", "--time", "0", session.id], { signal: AbortSignal.timeout(5_000) }).catch(() => {});
    await rm(staging, { recursive: true, force: true });
  }
}

/** Restore an exported patch at its declared target path inside the container. */
export async function restoreGitPatch(
  session: PatchSession,
  artifact: TransferArtifact,
  signal: AbortSignal,
): Promise<void> {
  validateGitPatchSpec(artifact.spec, session.workdir);
  signal.throwIfAborted();
  if (!/^[a-f0-9]{64}$/u.test(artifact.sha256) || (await digest(artifact.path, signal)) !== artifact.sha256)
    throw new GitPatchError("TRANSFER_CHECKSUM_MISMATCH", "Git patch digest does not match");
  const target = artifact.spec.target;
  await session.command(
    ["exec", session.id, "node", PROCESS_HELPER, "mkdir", posix.dirname(target), target, "file"],
    { signal },
  );
  await session.command(["cp", artifact.path, `${session.id}:${target}`], { signal });
  const verified = (
    await session.command(
      [
        "exec",
        session.id,
        "node",
        "-e",
        "const{createHash}=require('node:crypto');const{readFileSync}=require('node:fs');"
          + "process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'))",
        target,
      ],
      { signal },
    )
  ).stdout.trim();
  if (verified !== artifact.sha256)
    throw new GitPatchError("TRANSFER_CHECKSUM_MISMATCH", `Restored patch digest differs at ${target}`);
}
