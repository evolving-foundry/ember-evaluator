import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import type { PowerShellOperations } from "@earendil-works/pi-coding-agent";

// pi's native tool accepts custom operations but does not accept a PowerShell
// executable path. Bind the preflight result without its second `where` lookup.
export function powerShellOperations(executable: string): PowerShellOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1000 > 2_147_483_647)) {
        throw new Error("Invalid timeout: must be a positive, finite number of seconds within the timer limit");
      }
      signal?.throwIfAborted();
      const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n${command}`;
      // EncodedCommand preserves Unicode source with both Windows PowerShell
      // 5.1 and pwsh, independent of the host console code page.
      const child = spawn(
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-OutputFormat",
          "Text",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          cwd,
          env,
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let timedOut = false;
      let exited = false;
      let exitCode: number | null = null;
      let drainTimer: NodeJS.Timeout | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let termination: Promise<void> | undefined;
      let finishDrain: (() => void) | undefined;
      const stop = () => {
        // After shell exit, descendants may still hold/write its pipes. There
        // is no live shell PID to kill, but cancellation must end the drain.
        // The enclosing local runner Job owns remaining attempt descendants.
        if (exited) {
          finishDrain?.();
          return;
        }
        if (termination || child.pid === undefined) return;
        const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
        const taskkill = join(systemRoot, "System32", "taskkill.exe");
        termination = new Promise<void>(resolve => {
          execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, error => {
            if (error && !exited) child.kill();
            resolve();
          });
        });
      };
      try {
        const result = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          const finish = () => resolve({ exitCode });
          finishDrain = finish;
          // A detached descendant may retain a pipe after the shell exits.
          // Drain until output is idle so command completion cannot hang.
          const drain = () => {
            if (drainTimer) clearTimeout(drainTimer);
            drainTimer = setTimeout(finish, 100);
          };
          const data = (chunk: Buffer) => {
            onData(chunk);
            if (exited) drain();
          };
          child.stdout.on("data", data);
          child.stderr.on("data", data);
          child.once("error", reject);
          child.once("exit", code => {
            exited = true;
            exitCode = code;
            if (signal?.aborted || timedOut) finish();
            else drain();
          });
          child.once("close", code => {
            exitCode = code;
            finish();
          });
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
          if (timeout !== undefined)
            timeoutTimer = setTimeout(() => {
              timedOut = true;
              stop();
            }, timeout * 1000);
        });
        signal?.throwIfAborted();
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return result;
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (drainTimer) clearTimeout(drainTimer);
        signal?.removeEventListener("abort", stop);
        child.stdout.destroy();
        child.stderr.destroy();
        await termination;
      }
    },
  };
}
