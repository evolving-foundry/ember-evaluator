import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { aptSourceInstructions } from "../../src/infrastructure/containers/apt-sources.js";

const execute = promisify(execFile);
const enabled = process.platform === "linux" && process.env.EVALUATOR_APT_TESTS === "1";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function withRepository(
  failures: number | "always",
  run: (fixture: {
    root: string;
    requests: Map<string, number>;
    env: NodeJS.ProcessEnv;
    apply: () => Promise<void>;
    apt: (args: string[]) => Promise<{ code: number; output: string }>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "apt-download-"));
  const requests = new Map<string, number>();
  const server = createServer();
  try {
    for (const directory of ["apt/apt.conf.d", "apt/sources.list.d", "state/lists/partial", "cache/archives/partial", "logs", "bin", "package/DEBIAN"])
      await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, "status"), "");
    await writeFile(join(root, "bin/id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    await writeFile(join(root, "package/DEBIAN/control"), "Package: evaluator-apt-fixture\nVersion: 1.0\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nDescription: synthetic APT download test\n");
    await execute("dpkg-deb", ["--build", "--root-owner-group", join(root, "package"), join(root, "fixture.deb")]);
    const deb = await readFile(join(root, "fixture.deb"));
    const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    const packages = `Package: evaluator-apt-fixture\nVersion: 1.0\nArchitecture: all\nMaintainer: Fixture <fixture@example.invalid>\nFilename: pool/fixture.deb\nSize: ${deb.length}\nSHA256: ${sha256(deb)}\nDescription: synthetic APT download test\n\n`;
    const release = `Origin: synthetic-fixture\nDate: ${new Date().toUTCString()}\nSHA256:\n ${sha256(packages)} ${Buffer.byteLength(packages)} Packages\n`;
    const files = new Map<string, string | Buffer>([["/Release", release], ["/Packages", packages], ["/pool/fixture.deb", deb]]);
    server.on("request", (request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
      const count = (requests.get(path) ?? 0) + 1;
      requests.set(path, count);
      const retryTarget = path === "/pool/fixture.deb" || path === (failures === "always" ? "/Packages" : "/Release");
      if (retryTarget && (failures === "always" || count <= failures)) {
        response.writeHead(503); response.end("synthetic transient failure"); return;
      }
      const file = files.get(path);
      response.writeHead(file === undefined ? 404 : 200);
      response.end(file ?? "not found");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic repository port");
    // Only this loopback fixture is trusted. Production instructions never
    // disable repository signatures or touch the host's sources/status/cache.
    await writeFile(join(root, "apt/sources.list"), `deb [trusted=yes] http://127.0.0.1:${address.port} ./\n`);
    const config = join(root, "apt-config");
    await writeFile(config, `Dir::Etc "${root}/apt";\nDir::State "${root}/state";\nDir::State::status "${root}/status";\nDir::Cache "${root}/cache";\nDir::Log "${root}/logs";\nAPT::Architecture "amd64";\nAPT::Sandbox::User "${userInfo().username}";\nAcquire::Languages "none";\nAcquire::http::Proxy "DIRECT";\n`);
    const env = { ...process.env, APT_CONFIG: config, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}` };
    const apply = async () => {
      const instruction = aptSourceInstructions({ debian: String("https://mirror.example").replace(/\/$/u, "") + "/debian", debianSecurity: String("https://mirror.example").replace(/\/$/u, "") + "/debian-security", ubuntu: String("https://mirror.example").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("https://mirror.example").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("https://mirror.example").replace(/\/$/u, "") + "/ubuntu-ports" })[0];
      if (!instruction) throw new Error("Missing APT download defaults");
      await execute("sh", ["-ec", instruction.slice(4).replaceAll("/etc/apt", quote(join(root, "apt")))], { env });
    };
    const apt = async (args: string[]) => {
      try {
        const result = await execute("apt-get", args, { env, timeout: 45_000 });
        return { code: 0, output: result.stdout + result.stderr };
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "number") throw error;
        const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
        const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
        return { code: error.code, output: stdout + stderr };
      }
    };
    await run({ root, requests, env, apply, apt });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!enabled)("APT retries transient index and package downloads without installing packages", async () => {
  await withRepository(2, async ({ root, requests, apply, apt }) => {
    await apply();
    const updated = await apt(["update"]);
    expect(updated.code, updated.output).toBe(0);
    expect(requests.get("/Release")).toBe(3);
    const downloaded = await apt(["install", "--download-only", "-y", "evaluator-apt-fixture"]);
    expect(downloaded.code, downloaded.output).toBe(0);
    expect(requests.get("/pool/fixture.deb")).toBe(3);
    expect(await readFile(join(root, "status"), "utf8")).toBe("");
    expect(await readFile(join(root, "cache/archives/evaluator-apt-fixture_1.0_all.deb"))).toEqual(await readFile(join(root, "fixture.deb")));
  });
}, 60_000);

test.skipIf(!enabled)("APT exhausts its bounded retries and fails update instead of using missing indexes", async () => {
  await withRepository("always", async ({ requests, apply, apt }) => {
    await apply();
    const result = await apt(["update"]);
    expect(result.code, result.output).toBe(100);
    expect(requests.get("/Packages")).toBe(4);
    expect(requests.has("/pool/fixture.deb")).toBe(false);
  });
}, 60_000);

test.skipIf(!enabled)("APT defaults preserve existing options, accept later overrides and remain idempotent", async () => {
  await withRepository(0, async ({ root, env, apply }) => {
    await writeFile(join(root, "apt/apt.conf.d/10-image"), 'Acquire::Retries "1";\nAcquire::http::Timeout "7";\n');
    await apply();
    const defaults = join(root, "apt/apt.conf.d/00-evaluator-network-defaults");
    const initial = await readFile(defaults, "utf8");
    expect(initial).not.toContain("Acquire::Retries");
    expect(initial).not.toContain("Acquire::http::Timeout");
    expect((await execute("apt-config", ["shell", "value", "Acquire::Retries"], { env })).stdout).toBe("value='1'\n");
    expect((await execute("apt-config", ["shell", "value", "Acquire::http::Timeout"], { env })).stdout).toBe("value='7'\n");
    await writeFile(join(root, "apt/apt.conf.d/99-task"), 'Acquire::Retries "5";\n');
    await apply();
    expect(await readFile(defaults, "utf8")).toBe(initial);
    expect((await execute("apt-config", ["shell", "value", "Acquire::Retries"], { env })).stdout).toBe("value='5'\n");
    expect((await execute("apt-config", ["-o", "Acquire::Retries=9", "shell", "value", "Acquire::Retries"], { env })).stdout).toBe("value='9'\n");
  });
});
