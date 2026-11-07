import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import type { CommandSpec, ExitResult, ProcessHandle } from "../../core/contracts/environment.js";

const STREAM_BUFFER_BYTES = 1024 * 1024;
const ABORT_GRACE_MS = 500;
const FORCE_WAIT_MS = 2_000;

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}

function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)));
}

/** Minimal host environment for credential-free installers and metadata CLIs. */
export function runtimeProcessEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const essential = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"]);
  const proxy = new Set(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]);
  const inherited = Object.entries(process.env).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined &&
      (() => {
        const name = entry[0].toUpperCase();
        if (essential.has(name) || name === "NO_PROXY") return true;
        if (!proxy.has(name)) return false;
        try {
          const url = new URL(entry[1]);
          return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
        } catch {
          return false;
        }
      })(),
  );
  if (process.platform !== "win32") return { ...Object.fromEntries(inherited), ...extra };
  const merged = new Map<string, [string, string]>();
  for (const [name, value] of inherited) merged.set(name.toUpperCase(), [name.toUpperCase(), value]);
  for (const [name, value] of Object.entries(extra)) merged.set(name.toUpperCase(), [name, value]);
  return Object.fromEntries(merged.values());
}

class BoundedTail implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private ended = false;
  private failure: unknown;
  private waiter: {
    resolve(value: IteratorResult<Uint8Array>): void;
    reject(error: unknown): void;
  } | null = null;
  private iterated = false;

  constructor(
    stream: Readable,
    private readonly limit: number | null = STREAM_BUFFER_BYTES,
  ) {
    void this.drain(stream);
  }

  private async drain(stream: Readable): Promise<void> {
    try {
      for await (const value of stream) this.push(Buffer.from(value as Uint8Array));
      this.finish();
    } catch (error) {
      this.fail(error);
    }
  }

  private push(chunk: Uint8Array): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: chunk, done: false });
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.limit !== null && this.bytes > this.limit && this.chunks.length > 0) {
      const excess = this.bytes - this.limit;
      const first = this.chunks[0];
      if (!first) break;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.bytes -= first.byteLength;
      } else {
        this.chunks[0] = first.slice(excess);
        this.bytes -= excess;
      }
    }
  }

  private finish(): void {
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  private fail(error: unknown): void {
    this.failure = error;
    this.ended = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    if (this.iterated) throw new TypeError("process output can only be consumed once");
    this.iterated = true;
    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        const chunk = this.chunks.shift();
        if (chunk) {
          this.bytes -= chunk.byteLength;
          return { value: chunk, done: false };
        }
        if (this.failure !== undefined) throw this.failure;
        if (this.ended) return { value: undefined, done: true };
        return await new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
    };
  }
}

type Spawned = {
  child: ChildProcessWithoutNullStreams;
  terminateGracefully(): Promise<void>;
  terminateForcibly(): Promise<void>;
  cleanup(): Promise<void>;
};

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!errno(error, "ESRCH")) throw error;
  }
}

function spawnPosix(command: CommandSpec): Spawned {
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd,
    env: command.env,
    shell: false,
    detached: true,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("spawn did not return a process ID");
  return {
    child,
    async terminateGracefully() {
      killGroup(pid, "SIGTERM");
    },
    async terminateForcibly() {
      killGroup(pid, "SIGKILL");
    },
    async cleanup() {
      await Promise.resolve();
    },
  };
}

const WINDOWS_JOB_RUNNER = String.raw`param([Parameter(Mandatory=$true)][string]$Spec, [Parameter(Mandatory=$true)][string]$Control)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace EmberEvaluator {
  public static class JobRunner {
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint STARTF_USESTDHANDLES = 0x00000100;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    const uint HANDLE_FLAG_INHERIT = 0x00000001;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;
    const uint CTRL_BREAK_EVENT = 1;
    const int JobObjectBasicAccountingInformation = 1;
    const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
      public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
      public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute;
      public uint dwFlags; public short wShowWindow; public short cbReserved2;
      public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
      bool inheritHandles, uint flags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION processInfo);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, uint length, IntPtr returnLength);

    static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new char[] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
      StringBuilder result = new StringBuilder("\""); int slashes = 0;
      foreach (char character in value) {
        if (character == '\\') { slashes++; continue; }
        if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); slashes = 0; continue; }
        result.Append('\\', slashes); slashes = 0; result.Append(character);
      }
      result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
    }

    static IntPtr EnvironmentBlock(string[] entries) {
      Array.Sort(entries, StringComparer.OrdinalIgnoreCase);
      StringBuilder block = new StringBuilder();
      foreach (string entry in entries) block.Append(entry).Append('\0');
      block.Append('\0'); if (entries.Length == 0) block.Append('\0');
      return Marshal.StringToHGlobalUni(block.ToString());
    }

    static uint ActiveProcesses(IntPtr job) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, out info,
          (uint)Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) throw new Win32Exception();
      return info.ActiveProcesses;
    }

    public static int Run(string executable, string[] args, string cwd, string[] environment, string control) {
      IntPtr job = IntPtr.Zero, environmentBlock = IntPtr.Zero;
      PROCESS_INFORMATION child = new PROCESS_INFORMATION();
      try {
        job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception();
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
            (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) throw new Win32Exception();

        STARTUPINFO startup = new STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(-10); startup.hStdOutput = GetStdHandle(-11); startup.hStdError = GetStdHandle(-12);
        SetHandleInformation(startup.hStdInput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(startup.hStdOutput, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        SetHandleInformation(startup.hStdError, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        StringBuilder command = new StringBuilder(Quote(executable)); foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        environmentBlock = EnvironmentBlock(environment);
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
            CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
            environmentBlock, cwd, ref startup, out child)) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, child.hProcess)) throw new Win32Exception();
        if (ResumeThread(child.hThread) == UInt32.MaxValue) throw new Win32Exception();

        bool gracefulSent = false;
        while (true) {
          uint status = WaitForSingleObject(child.hProcess, 20);
          if (status == WAIT_OBJECT_0) {
            uint code; if (!GetExitCodeProcess(child.hProcess, out code)) throw new Win32Exception();
            if (ActiveProcesses(job) > 0) TerminateJobObject(job, 137);
            for (int count = 0; count < 100 && ActiveProcesses(job) > 0; count++) Thread.Sleep(10);
            return unchecked((int)code);
          }
          if (status != WAIT_TIMEOUT) throw new Win32Exception();
          string request = null;
          try { if (File.Exists(control)) request = File.ReadAllText(control).Trim(); } catch (IOException) {}
          if (request == "term" && !gracefulSent) { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.dwProcessId); gracefulSent = true; }
          if (request == "kill") { TerminateJobObject(job, 137); }
        }
      } finally {
        if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
        if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
        if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
        if (job != IntPtr.Zero) CloseHandle(job);
      }
    }
  }
}
'@
$json = [IO.File]::ReadAllText($Spec, [Text.Encoding]::UTF8)
Remove-Item -LiteralPath $Spec -Force
$decoded = $json | ConvertFrom-Json
$environment = @($decoded.env.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" })
$result = [EmberEvaluator.JobRunner]::Run([string]$decoded.executable, [string[]]$decoded.args, [string]$decoded.cwd, [string[]]$environment, $Control)
exit $result
`;

function windowsPowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function spawnWindows(command: CommandSpec): Promise<Spawned> {
  for (const key of Object.keys(command.env)) {
    if (key.includes("=") || key.includes("\0"))
      throw new TypeError("environment variable names cannot contain '=' or NUL");
  }
  const identifier = randomUUID();
  const script = join(tmpdir(), `ember-job-${identifier}.ps1`);
  const spec = join(tmpdir(), `ember-job-${identifier}.json`);
  const control = join(tmpdir(), `ember-job-${identifier}.control`);
  await writeFile(script, WINDOWS_JOB_RUNNER, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    // Arguments and environment values stay in a user-protected temporary
    // file rather than the inspectable PowerShell command line. stdin remains
    // exclusively on the inherited pipe.
    await writeFile(
      spec,
      JSON.stringify({
        executable: command.executable,
        args: command.args,
        cwd: command.cwd,
        env: command.env,
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    await rm(script, { force: true });
    throw error;
  }
  const child = spawn(
    windowsPowerShell(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Spec",
      spec,
      "-Control",
      control,
    ],
    {
      cwd: command.cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  return {
    child,
    async terminateGracefully() {
      await writeFile(control, "term", "utf8");
    },
    async terminateForcibly() {
      await writeFile(control, "kill", "utf8");
    },
    async cleanup() {
      await Promise.all([rm(script, { force: true }), rm(spec, { force: true }), rm(control, { force: true })]);
    },
  };
}

async function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const spawned = () => {
      child.off("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      child.off("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

export async function startLocalProcess(
  command: CommandSpec,
  signal: AbortSignal,
  options: { inheritEnv?: boolean } = {},
): Promise<ProcessHandle> {
  if (signal.aborted) throw abortError();
  if (command.outputBufferBytes !== undefined && command.outputBufferBytes !== null &&
    (!Number.isSafeInteger(command.outputBufferBytes) || command.outputBufferBytes <= 0))
    throw new TypeError("outputBufferBytes must be a positive integer or null");
  const inheritEnv = options.inheritEnv ?? command.inheritEnv ?? true;
  const inherited =
    inheritEnv === false
      ? runtimeProcessEnvironment()
      : Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
  let env = { ...inherited, ...command.env };
  if (process.platform === "win32") {
    // Windows names are case-insensitive. Merge before JSON serialization so
    // PowerShell never sees HTTP_PROXY/http_proxy as duplicate properties.
    // Explicit command entries override inherited entries regardless of case;
    // within a layer the last spelling wins. POSIX keeps distinct names.
    const entries = new Map<string, [string, string]>();
    for (const layer of [inherited, command.env]) {
      for (const [name, value] of Object.entries(layer)) entries.set(name.toUpperCase(), [name, value]);
    }
    env = Object.fromEntries(entries.values());
  }
  const effectiveCommand: CommandSpec = { ...command, env };
  const spawned = process.platform === "win32" ? await spawnWindows(effectiveCommand) : spawnPosix(effectiveCommand);
  const { child } = spawned;
  try {
    await waitForSpawn(child);
  } catch (error) {
    await spawned.cleanup();
    throw error;
  }

  const stdout = new BoundedTail(child.stdout, command.outputBufferBytes);
  const stderr = new BoundedTail(child.stderr, command.outputBufferBytes);
  let rootExited = false;
  const closed = new Promise<ExitResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => {
      rootExited = true;
      if (process.platform !== "win32" && child.pid !== undefined) {
        // `close` waits for descendants that inherited the root's pipes. Kill
        // the group at root exit so those pipes can close and `done` can settle.
        try {
          killGroup(child.pid, "SIGKILL");
        } catch (error) {
          reject(error);
        }
      }
    });
    child.once("close", (code, exitSignal) => {
      resolve({ code, signal: exitSignal });
    });
  });
  const done = closed.finally(() => spawned.cleanup());
  let stopPromise: Promise<void> | null = null;
  const handle: ProcessHandle = {
    stdout,
    stderr,
    done,
    stop(graceMs: number): Promise<void> {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (rootExited) return;
        await spawned.terminateGracefully();
        const completed = await Promise.race([
          done.then(
            () => true,
            () => true,
          ),
          wait(graceMs).then(() => false),
        ]);
        if (completed || rootExited) return;
        await spawned.terminateForcibly();
        const forced = await Promise.race([
          done.then(
            () => true,
            () => true,
          ),
          wait(FORCE_WAIT_MS).then(() => false),
        ]);
        if (!forced && !rootExited) child.kill("SIGKILL");
        await Promise.race([
          done.then(
            () => undefined,
            () => undefined,
          ),
          wait(FORCE_WAIT_MS),
        ]);
      })();
      return stopPromise;
    },
  };
  const abort = () => {
    void handle.stop(ABORT_GRACE_MS).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  void done.finally(() => signal.removeEventListener("abort", abort)).catch(() => {});

  child.stdin.on("error", error => {
    if (!errno(error, "EPIPE")) child.emit("error", error);
  });
  if (command.input === null) child.stdin.end();
  else child.stdin.end(command.input);
  if (signal.aborted) abort();
  return handle;
}
