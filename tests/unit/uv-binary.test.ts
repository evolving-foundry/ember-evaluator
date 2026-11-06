import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const probe = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: probe }),
  };
});
import { resolveLinuxUvBinary } from "../../src/infrastructure/runtime-installation/uv-binary.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";

const originalEnv = { ...process.env };
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  probe.mockReset();
  process.env = { ...originalEnv };
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

async function binary(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uv-probe-"));
  temporary.push(root);
  const path = join(root, "uv");
  await writeFile(path, bytes);
  process.env.UV_BIN = path;
  return path;
}

test("probes the supplied Linux ELF in a pinned offline container on Windows", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const elf = Buffer.alloc(20);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf[18] = 0x3e;
  const path = await binary(elf);
  probe.mockRejectedValueOnce(new Error("cannot execute ELF on Windows"));
  probe.mockResolvedValueOnce({ stdout: "uv 0.9.9\n", stderr: "" });
  const signal = new AbortController().signal;
  expect(await resolveLinuxUvBinary(signal, message => new Error(message))).toEqual({ path, version: "0.9.9" });
  expect(probe).toHaveBeenNthCalledWith(2, "docker", [
    "run", "--rm", "--pull=never", "--network=none", "--platform=linux/amd64",
    "--mount", `type=bind,source=${path},target=/uv,readonly`,
    "--entrypoint", "/uv", PINNED_NODE_IMAGE, "--version",
  ], expect.objectContaining({ signal }));
});

test("rejects a non-Linux binary before starting a container", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  await binary(Buffer.from("MZ not a Linux binary"));
  probe.mockRejectedValue(new Error("not executable"));
  await expect(resolveLinuxUvBinary(new AbortController().signal, message => new Error(message)))
    .rejects.toThrow("not a linux/x86_64 executable");
  expect(probe).toHaveBeenCalledTimes(1);
});

test("propagates cancellation without starting a fallback container", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const controller = new AbortController();
  controller.abort();
  probe.mockRejectedValue(controller.signal.reason);
  await expect(resolveLinuxUvBinary(controller.signal, message => new Error(message))).rejects.toBe(controller.signal.reason);
  expect(probe).toHaveBeenCalledTimes(1);
});
