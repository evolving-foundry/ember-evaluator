import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { aptSourceInstructions } from "../../src/infrastructure/containers/apt-sources.js";

const execute = promisify(execFile);

async function withAptDirectory(run: (root: string, apply: (mirror: string) => Promise<void>) => Promise<void>, uid = "0") {
  const root = await mkdtemp(join(tmpdir(), "evaluator-apt-mirror-"));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  try {
    await mkdir(join(root, "sources.list.d"));
    await mkdir(join(root, "apt.conf.d"));
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/id"), `#!/bin/sh\nprintf '${uid}\\n'\n`, { mode: 0o755 });
    await writeFile(join(root, "bin/apt-config"), '#!/bin/sh\nif [ -f "$APT_TEST_ROOT/explicit-options" ] && grep -Fxq "$3" "$APT_TEST_ROOT/explicit-options"; then echo "evaluator_value=explicit"; fi\nexit 0\n', { mode: 0o755 });
    // Observe bootstrap ordering without accessing the machine's APT or trust store.
    await writeFile(join(root, "bin/apt-get"), '#!/bin/sh\ncat "$APT_TEST_ROOT/sources.list.d/ubuntu.sources" >> "$APT_TEST_ROOT/calls"\nprintf "%s\\n" "$*" >> "$APT_TEST_ROOT/calls"\nif [ "$1" = install ]; then touch "$APT_TEST_ROOT/ca.crt"; fi\n', { mode: 0o755 });
    await run(root, async mirror => {
      const script = aptSourceInstructions({ debian: String(mirror).replace(/\/$/u, "") + "/debian", debianSecurity: String(mirror).replace(/\/$/u, "") + "/debian-security", ubuntu: String(mirror).replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String(mirror).replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String(mirror).replace(/\/$/u, "") + "/ubuntu-ports" }).map(instruction => instruction.slice(4)).join("\n")
        .replaceAll("/etc/apt", quote(root))
        .replaceAll("/etc/ssl/certs/ca-certificates.crt", quote(join(root, "ca.crt")))
        .replaceAll("/var/lib/apt/lists", quote(join(root, "lists")));
      await execute("sh", ["-c", script], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, APT_TEST_ROOT: root } });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("HTTPS task mirrors bootstrap missing CA trust before switching sources", () => {
  const instructions = aptSourceInstructions({ debian: String("https://repo.example.test").replace(/\/$/u, "") + "/debian", debianSecurity: String("https://repo.example.test").replace(/\/$/u, "") + "/debian-security", ubuntu: String("https://repo.example.test").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("https://repo.example.test").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("https://repo.example.test").replace(/\/$/u, "") + "/ubuntu-ports" });
  expect(instructions).toHaveLength(3);
  expect(instructions[0]).toContain('Acquire::Retries "3";');
  expect(instructions[1]).toContain("[ ! -s /etc/ssl/certs/ca-certificates.crt ]");
  expect(instructions[1]).toContain("http://repo.example.test/debian");
  expect(instructions[1]).toContain("apt-get install -y --no-install-recommends ca-certificates");
  expect(instructions[2]).toContain("https://repo.example.test/debian");
  expect(instructions.join("\n")).not.toMatch(/allow-unauthenticated|trusted=yes|Verify-Peer/);
});

test("HTTP mirrors and custom ports retain the selected origin", () => {
  expect(aptSourceInstructions({ debian: String("http://mirror.example:8080").replace(/\/$/u, "") + "/debian", debianSecurity: String("http://mirror.example:8080").replace(/\/$/u, "") + "/debian-security", ubuntu: String("http://mirror.example:8080").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("http://mirror.example:8080").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("http://mirror.example:8080").replace(/\/$/u, "") + "/ubuntu-ports" })).toHaveLength(2);
  expect(aptSourceInstructions({ debian: String("http://mirror.example:8080").replace(/\/$/u, "") + "/debian", debianSecurity: String("http://mirror.example:8080").replace(/\/$/u, "") + "/debian-security", ubuntu: String("http://mirror.example:8080").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("http://mirror.example:8080").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("http://mirror.example:8080").replace(/\/$/u, "") + "/ubuntu-ports" })[1]).toContain("http://mirror.example:8080/debian");
  expect(aptSourceInstructions({ debian: String("https://mirror.example:8443").replace(/\/$/u, "") + "/debian", debianSecurity: String("https://mirror.example:8443").replace(/\/$/u, "") + "/debian-security", ubuntu: String("https://mirror.example:8443").replace(/\/$/u, "") + "/ubuntu", ubuntuSecurity: String("https://mirror.example:8443").replace(/\/$/u, "") + "/ubuntu", ubuntuPorts: String("https://mirror.example:8443").replace(/\/$/u, "") + "/ubuntu-ports" })[1]).toContain("http://mirror.example:8443/debian");
});

test.skipIf(process.platform === "win32")("APT defaults preserve explicit image options and leave room for task overrides", async () => {
  await withAptDirectory(async (root, apply) => {
    await writeFile(join(root, "ca.crt"), "existing CA trust");
    await writeFile(join(root, "explicit-options"), "Acquire::Retries\nAcquire::https::Timeout\n");
    await apply("https://mirror.example");
    const defaults = await readFile(join(root, "apt.conf.d/00-evaluator-network-defaults"), "utf8");
    expect(defaults).toBe('Acquire::http::Timeout "30";\nAPT::Update::Error-Mode "any";\n');
  });
});

test.skipIf(process.platform === "win32").each(["http://mirror.example:8080", "https://mirror.example:8443"])("rewrites official Debian and Ubuntu sources on disk using %s", async mirror => {
  await withAptDirectory(async (root, apply) => {
    await writeFile(join(root, "ca.crt"), "existing CA trust");
    const inputs = {
      "sources.list": "deb https://deb.debian.org/debian bookworm main\ndeb http://security.debian.org/debian-security bookworm-security main\n",
      "sources.list.d/debian.sources": "URIs: http://deb.debian.org/debian/ https://deb.debian.org/debian-security/\nSuites: bookworm bookworm-updates\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n",
      "sources.list.d/ubuntu.sources": "URIs: http://archive.ubuntu.com/ubuntu/ https://security.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n",
      "sources.list.d/extra sources.list": "deb [arch=amd64] https://us.archive.ubuntu.com/ubuntu noble main\ndeb http://ports.ubuntu.com/ubuntu-ports/ noble main\n",
      "sources.list.d/private.list": "deb https://private.example/ubuntu noble main\ndeb https://archive.ubuntu.com/ubuntu-extra noble main\n",
      "sources.list.d/ignored.txt": "http://archive.ubuntu.com/ubuntu/\n",
    };
    for (const [name, text] of Object.entries(inputs)) await writeFile(join(root, name), text);
    await apply(mirror);
    for (const [name, original] of Object.entries(inputs)) {
      const expected = original.replaceAll("https://deb.debian.org/", mirror + "/")
        .replaceAll("http://deb.debian.org/", mirror + "/").replaceAll("http://security.debian.org/", mirror + "/")
        .replaceAll("http://archive.ubuntu.com/ubuntu/", mirror + "/ubuntu/")
        .replaceAll("https://security.ubuntu.com/ubuntu/", mirror + "/ubuntu/")
        .replaceAll("https://us.archive.ubuntu.com/ubuntu ", mirror + "/ubuntu ")
        .replaceAll("http://ports.ubuntu.com/ubuntu-ports/", mirror + "/ubuntu-ports/");
      expect(await readFile(join(root, name), "utf8")).toBe(name.endsWith(".txt") ? original : expected);
    }
  });
});

test.skipIf(process.platform === "win32")("Ubuntu without CA bootstraps through HTTP before using HTTPS", async () => {
  await withAptDirectory(async (root, apply) => {
    await writeFile(join(root, "sources.list.d/ubuntu.sources"), "URIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble\n");
    await apply("https://mirror.example");
    expect(await readFile(join(root, "calls"), "utf8")).toContain("URIs: http://mirror.example/ubuntu/\nSuites: noble\nupdate");
    expect(await readFile(join(root, "calls"), "utf8")).toContain("install -y --no-install-recommends ca-certificates");
    expect(await readFile(join(root, "sources.list.d/ubuntu.sources"), "utf8")).toBe("URIs: https://mirror.example/ubuntu/\nSuites: noble\n");
  });
});

test.skipIf(process.platform === "win32")("existing HTTPS mirror sources bootstrap CA before restoring HTTPS", async () => {
  await withAptDirectory(async (root, apply) => {
    const origin = "https://mirror.example:8443";
    const sources = {
      "sources.list": `deb ${origin}/debian bookworm main\n`,
      "sources.list.d/debian.list": `deb ${origin}/debian-security bookworm-security main\n`,
      "sources.list.d/ubuntu.sources": `URIs: ${origin}/ubuntu/\nSuites: noble\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`,
      "sources.list.d/private.list": "deb https://private.example/ubuntu noble main\n",
    };
    for (const [name, contents] of Object.entries(sources)) await writeFile(join(root, name), contents);
    await apply(origin);
    const calls = await readFile(join(root, "calls"), "utf8");
    expect(calls).toContain("URIs: http://mirror.example:8443/ubuntu/");
    expect(calls).not.toContain("URIs: https://");
    expect(calls).toContain("install -y --no-install-recommends ca-certificates");
    for (const [name, contents] of Object.entries(sources)) expect(await readFile(join(root, name), "utf8")).toBe(contents);
  });
});

test.skipIf(process.platform === "win32")("non-root stages leave APT sources unchanged", async () => {
  await withAptDirectory(async (root, apply) => {
    const original = "URIs: http://archive.ubuntu.com/ubuntu/\n";
    await writeFile(join(root, "sources.list.d/ubuntu.sources"), original);
    await apply("https://mirror.example");
    expect(await readFile(join(root, "sources.list.d/ubuntu.sources"), "utf8")).toBe(original);
    await expect(readFile(join(root, "apt.conf.d/00-evaluator-network-defaults"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, "1000");
});
