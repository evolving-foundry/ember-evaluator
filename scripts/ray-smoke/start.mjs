import { mkdir, readFile, writeFile, copyFile, access, symlink } from "node:fs/promises";
import { randomBytes, X509Certificate } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const role = process.argv[2];
if (role === "init") {
  await mkdir("/security", { recursive: true });
  try { await access("/security/token"); }
  catch { await writeFile("/security/token", randomBytes(32).toString("hex"), { mode: 0o600 }); }
  try { await access("/security/jobs-token"); }
  catch { await writeFile("/security/jobs-token", randomBytes(32).toString("hex"), { mode: 0o600 }); }
  try {
    await access("/security/key.pem");
    const cert = new X509Certificate(await readFile("/security/cert.pem"));
    if (!cert.checkHost("head") || !cert.checkHost("host.docker.internal") || Date.parse(cert.validTo) <= Date.now()) throw new Error("Renew smoke certificate");
  }
  catch {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-keyout", "/security/key.pem", "-out", "/security/cert.pem", "-subj", "/CN=coordinator", "-addext", "subjectAltName=DNS:head,DNS:gateway,DNS:coordinator,DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { stdio: "inherit" });
  }
} else {
  await mkdir("/experiment", { recursive: true });
  await mkdir("/experiment/node_modules", { recursive: true });
  try { await symlink("/opt/evaluator", "/experiment/node_modules/ember-evaluator", "dir"); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  for (const name of ["controlled.mjs", "office-solver.mjs"]) await copyFile(new URL(name, import.meta.url), `/experiment/${name}`);
  await writeFile("/experiment/cordis.patch.yaml", JSON.stringify([{ insert: [{ id: "ray-smoke", name: "./controlled.mjs" }, { id: "office-smoke", name: "./office-solver.mjs" }] }]));
  process.env.EVALUATOR_TRANSFER_TOKEN = (await readFile("/security/token", "utf8")).trim();
  if (role === "worker") {
    await mkdir("/node", { recursive: true });
    const configDirectory = process.env.EVALUATOR_WORKER_PROFILE === "builtin" ? "/builtin-experiment" : "/experiment";
    await mkdir(configDirectory, { recursive: true });
    await writeFile("/node/config.json", JSON.stringify({ nodeExecutable: "/usr/local/bin/node", workerEntry: "/opt/evaluator/dist/application/ray/node-worker.js", configDirectory, outputRoot: "/node/evidence", caFile: "/security/cert.pem", ...(configDirectory === "/experiment" ? { pluginPatchPath: "/experiment/cordis.patch.yaml" } : {}), dockerExecutable: "/usr/local/bin/docker" }));
    process.env.EVALUATOR_NODE_CONFIG = "/node/config.json";
  }
  // Deployment-layer capacity: each worker offers EVALUATOR_NODE_SLOTS evaluator slots.
  const slots = Math.max(Number.parseInt(process.env.EVALUATOR_NODE_SLOTS ?? "1", 10) || 1, 1);
  const args = role === "head" ? ["start", "--head", "--port=6379", "--ray-client-server-port=10001", "--num-cpus=0", "--object-store-memory=134217728", "--include-dashboard=true", "--dashboard-host=0.0.0.0", "--block"]
    : role === "worker" ? ["start", "--address=head:6379", `--num-cpus=${slots}`, `--resources={"evaluator_slot":${slots}}`, "--object-store-memory=134217728", "--block"] : null;
  if (args) {
    const child = spawn("ray", args, { stdio: "inherit", env: process.env });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("exit", code => { process.exitCode = code ?? 1; });
  } else if (role === "gateway") {
    await import("../../dist/application/ray/entries/jobs-gateway.mjs");
  } else if (role === "coordinator") {
    // docker compose exec does not inherit variables set by this process.
    setInterval(() => {}, 60_000);
  } else throw new Error(`Unknown role: ${role}`);
}
