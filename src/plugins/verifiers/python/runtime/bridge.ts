import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { AttemptKey } from "../../../../core/contracts/result.js";
import type { VerificationRuntimeSession } from "../../../../core/contracts/verification-runtime.js";
import type { VerificationEvidence, VerificationTask } from "../../../../core/contracts/verifier.js";
import { expectRecord, assertJsonValue } from "../../../../core/validation/input.js";
import { redactSecrets } from "../../../../config/redact.js";
import { redactDiagnostic } from "../../../../core/errors/diagnostics.js";
import { readProcess } from "../../../../infrastructure/process/output.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import type { JsonValue } from "../../../../core/contracts/task.js";

import { createVerifierContainer } from "../../shared/container.js";

async function boundedArchive(work: () => Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      void work().then(resolve, reject);
    });
  } finally { signal.removeEventListener("abort", abort); }
}

/** A worker can only address the mounted dataset, its output and explicit RPC. */
export async function preparePythonVerifier(
  task: VerificationTask, importPath: string, env: Record<string, string>, docker: string,
  image: string, key: AttemptKey, signal: AbortSignal, secrets: readonly string[] = [],
): Promise<VerificationRuntimeSession<VerificationEvidence>> {
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const taskRelative = relative(task.datasetDir, task.taskDir);
  if (taskRelative.startsWith("..") || resolve(task.datasetDir, taskRelative) !== resolve(task.taskDir)) throw new Error("Task is outside the verifier dataset");
  const staging = await mkdtemp(join(tmpdir(), "evaluator-verifier-"));
  const trial = join(staging, "trial");
  let container;
  try {
    await mkdir(join(trial, "verifier"), { recursive: true });
    container = await createVerifierContainer(docker, image, ["--add-host", "host.docker.internal:host-gateway",
      "--mount", `type=bind,source=${resolve(task.datasetDir)},target=/dataset,readonly`,
      "--mount", `type=bind,source=${trial},target=/trial`], [], key, signal);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  const calls = new Set<Promise<void>>();
  let verificationFinished: Promise<void> = Promise.resolve();
  return {
    metadata: container.metadata,
    async dispose(cleanupSignal) {
      lifetime.abort(new Error("Verifier worker ended"));
      await container.dispose(cleanupSignal);
      await boundedArchive(() => verificationFinished, cleanupSignal);
      await Promise.allSettled(calls);
      await rm(staging, { recursive: true, force: true });
    },
    async verify(_result, session, verifySignal) {
      const finished = Promise.withResolvers<void>();
      verificationFinished = finished.promise;
      try {
        if (!session) throw new Error("Python verifier requires a task environment");
        const active = AbortSignal.any([verifySignal, lifetime.signal, ...(task.timeoutSeconds === undefined ? [] : [AbortSignal.timeout(Math.ceil(task.timeoutSeconds * 1000))])]);
        const { worker, done } = container.start(active);
        let diagnostic = "";
        worker.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-16384); });
        worker.stdin.on("error", () => {});
        const write = (value: unknown) => { if (!worker.stdin.destroyed) worker.stdin.write(JSON.stringify(value) + "\n"); };
        const localPath = (source: string, prefix: string, root: string) => {
          if (source !== prefix && !source.startsWith(prefix + "/")) throw new Error("Worker path is outside its admitted mount");
          const path = resolve(root, source.slice(prefix.length + 1));
          const offset = relative(root, path);
          if (offset === ".." || offset.startsWith(".." + sep)) throw new Error("Worker path escapes its mount");
          return path;
        };
        let result: VerificationEvidence | undefined;
        let failure: unknown;
        let failed = false;
        let nativeError: JsonValue = null;
        try {
          active.throwIfAborted();
          const workerEnv = Object.fromEntries(Object.entries(env).map(([key, value]) => [key, /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/u.test(value) ? value.replace(/\/\/(?:localhost|127\.0\.0\.1|\[::1\])/u, "//host.docker.internal") : value]));
          write({ importPath, taskDir: "/dataset" + (taskRelative ? "/" + taskRelative.split(sep).join("/") : ""), env: workerEnv });
          for await (const line of createInterface({ input: worker.stdout, crlfDelay: Infinity })) {
            active.throwIfAborted();
            if (Buffer.byteLength(line) > 32 * 1024 * 1024) throw new Error("Python verifier protocol exceeds limit");
            const message = expectRecord(JSON.parse(line), "Python verifier message");
            if (message.type === "error") {
              if (message.details !== undefined) {
                assertJsonValue(message.details);
                nativeError = message.details;
              }
              throw new Error(String(message.message));
            }
            if (message.type === "result") {
              const rewards = expectRecord(message.rewards, "Python verifier rewards");
              if (!Object.keys(rewards).length || Object.values(rewards).some(item => typeof item !== "number" || !Number.isFinite(item))) throw new Error("Invalid Python verifier rewards");
              assertJsonValue(message.details);
              result = { rewards: rewards as Record<string, number>, details: redactSecrets(JSON.parse(redactDiagnostic(JSON.stringify(message.details), secrets))) };
              continue;
            }
            if (message.type !== "call" || typeof message.id !== "number") throw new Error("Unexpected Python verifier message");
            const call = (async () => {
              let response: unknown = null;
              if (message.operation === "exec") {
                if (typeof message.command !== "string" || (message.cwd !== null && typeof message.cwd !== "string")) throw new Error("Invalid verifier exec");
                const vars = expectRecord(message.env, "Python verifier env");
                if (Object.values(vars).some(value => typeof value !== "string")) throw new Error("Invalid verifier exec env");
                const callSignal = typeof message.timeout === "number" ? AbortSignal.any([active, AbortSignal.timeout(Math.ceil(message.timeout * 1000))]) : active;
                const process = await session.start({ executable: "bash", args: ["-c", message.command], cwd: message.cwd ?? session.workdir,
                  env: vars as Record<string, string>, input: null }, callSignal);
                const output = await readProcess(process, callSignal, 8 * 1024 * 1024);
                response = { return_code: output.code ?? 1, stdout: output.stdout, stderr: output.stderr };
              } else if (message.operation === "upload_dir") {
                if (typeof message.source !== "string" || typeof message.target !== "string") throw new Error("Invalid verifier upload");
                await session.upload(localPath(message.source, "/dataset", task.datasetDir), message.target, active);
              } else if (message.operation === "upload_file") {
                if (typeof message.data !== "string" || typeof message.target !== "string") throw new Error("Invalid verifier file upload");
                const file = join(staging, `upload-${randomUUID()}`);
                await writeFile(file, Buffer.from(message.data, "base64"));
                try { await session.upload(file, message.target, active); } finally { await rm(file, { force: true }); }
              } else if (message.operation === "download_dir") {
                if (typeof message.source !== "string" || typeof message.target !== "string") throw new Error("Invalid verifier download");
                await session.download(message.source, localPath(message.target, "/trial", trial), active);
              } else throw new Error("Unsupported verifier RPC");
              write({ id: message.id, result: response });
            })().catch(error => { write({ id: message.id, error: redactDiagnostic(error instanceof Error ? error.message : String(error), secrets) }); });
            calls.add(call);
            void call.finally(() => calls.delete(call));
          }
          await Promise.all(calls);
          const code = await done;
          active.throwIfAborted();
          if (code !== 0 || !result) throw new Error(`Python verifier failed: ${redactDiagnostic(diagnostic, secrets)}`);
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          lifetime.abort(new Error("Verifier worker ended"));
          worker.kill();
          await Promise.allSettled(calls);
        }
        // The scoring deadline may already be cancelled. Stop writers, preserve
        // available evidence with a separate budget, and only then release staging.
        const archiveSignal = AbortSignal.timeout(30_000);
        let cleanupError: string | null = null;
        if (failed) {
          try { await boundedArchive(() => container.dispose(archiveSignal), archiveSignal); }
          catch (error) { cleanupError = redactDiagnostic(String(error), secrets); }
        }
        const stderr = redactDiagnostic(diagnostic, secrets);
        const message = failed ? redactDiagnostic(failure instanceof Error ? failure.message : String(failure), secrets) : null;
        const diagnostics = redactSecrets(JSON.parse(redactDiagnostic(JSON.stringify({
          error: message, native: nativeError, stderr, cleanupError,
        }), secrets))) as JsonValue;
        let archiveError: string | null = null;
        try {
          const sanitize = async (directory: string): Promise<void> => {
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              archiveSignal.throwIfAborted();
              const file = join(directory, entry.name);
              if (entry.isSymbolicLink()) throw new Error("Verifier evidence cannot contain symlinks");
              if (entry.isDirectory()) await sanitize(file);
              else if (/\.(?:jsonl?|txt|log|out|ya?ml)$/iu.test(entry.name)) {
                if ((await lstat(file)).size > 32 * 1024 * 1024) throw new Error("Verifier text evidence exceeds limit");
                await writeFile(file, redactDiagnostic(await readFile(file, "utf8"), secrets));
              }
            }
          };
          await sanitize(join(trial, "verifier"));
          if (failed || stderr) await writeFile(join(trial, "verifier", "evaluator-worker.json"), JSON.stringify(diagnostics, null, 2) + "\n", { flag: "wx" });
          // Session paths belong to the execution environment, which may be Docker
          // or remote. Transfer evidence through its file API instead of host fs.
          await boundedArchive(() => session.upload(join(trial, "verifier"), session.verifierOutputDir, archiveSignal), archiveSignal);
        } catch (error) { archiveError = redactDiagnostic(String(error), secrets); }
        if (failed || archiveError) {
          const detail = stderr ? `\nVerifier stderr: ${stderr.slice(-2048)}` : "";
          throw Object.assign(new VerificationError((message ?? "Cannot archive Python verifier evidence") + detail,
            { diagnostics, archiveError }, { cause: failure ?? new Error(archiveError ?? "Verifier failed") }), { code: "VERIFY_EXEC_FAILED" });
        }
        if (!result) throw new Error("Python verifier produced no result");
        return result;
      } finally { finished.resolve(); }
    },
  };
}
