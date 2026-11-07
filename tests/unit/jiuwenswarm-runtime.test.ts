import { expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  JIUWENSWARM_VERSION,
  jiuwenswarmRuntimeInstallation,
  resolveJiuwenswarmCommand,
} from "../../src/runtimes/jiuwenswarm/runtime.js";

test("pins the semver form of the companion runtime within the declared range", () => {
  expect(JIUWENSWARM_VERSION).toBe("0.2.5");
});

test("materializes only the vendored AgentBundle SDK assets", async () => {
  const installation = await jiuwenswarmRuntimeInstallation(new AbortController().signal);
  expect(installation.commands).toEqual([]);
  expect(installation.files.map(file => file.target)).toContain("agentbundle/run.mjs");
  expect(installation.probes.length).toBeGreaterThanOrEqual(1);
  expect(installation.id).toMatch(/^jiuwenswarm:/);
});

test("resolves the host jiuwenswarm process without probing", async () => {
  expect(await resolveJiuwenswarmCommand({ PATH: "" })).toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), "jw-runtime-"));
  try {
    const bin = join(root, ".venv", "bin", "jiuwenswarm-process");
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, "#!/bin/sh\n");
    await chmod(bin, 0o755);
    expect(await resolveJiuwenswarmCommand({ JIUWENSWARM_CHECKOUT: root })).toEqual({
      command: bin,
      source: "JIUWENSWARM_CHECKOUT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves the Windows Scripts layout of the companion checkout venv", async () => {
  const windows = await mkdtemp(join(tmpdir(), "jw-runtime-scripts-"));
  try {
    const exe = join(windows, ".venv", "Scripts", "jiuwenswarm-process.exe");
    await mkdir(dirname(exe), { recursive: true });
    await writeFile(exe, "stub\n");
    await chmod(exe, 0o755);
    await writeFile(join(windows, ".venv", "Scripts", "jiuwenswarm-process"), "stub\n");
    await chmod(join(windows, ".venv", "Scripts", "jiuwenswarm-process"), 0o755);
    expect(await resolveJiuwenswarmCommand({ JIUWENSWARM_CHECKOUT: windows })).toEqual({
      command: exe,
      source: "JIUWENSWARM_CHECKOUT",
    });
  } finally {
    await rm(windows, { recursive: true, force: true });
  }

  // A checkout carrying both layouts keeps resolving the POSIX entry first.
  const both = await mkdtemp(join(tmpdir(), "jw-runtime-both-"));
  try {
    const posix = join(both, ".venv", "bin", "jiuwenswarm-process");
    const exe = join(both, ".venv", "Scripts", "jiuwenswarm-process.exe");
    for (const path of [posix, exe]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "stub\n");
      await chmod(path, 0o755);
    }
    expect(await resolveJiuwenswarmCommand({ JIUWENSWARM_CHECKOUT: both })).toEqual({
      command: posix,
      source: "JIUWENSWARM_CHECKOUT",
    });
  } finally {
    await rm(both, { recursive: true, force: true });
  }
});
