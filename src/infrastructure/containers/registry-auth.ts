import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type RegistryCredential = { username: string; password: string } | { identityToken: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function registryHost(value: string): string {
  try {
    const host = new URL(value.includes("://") ? value : `https://${value}`).host;
    return ["index.docker.io", "registry-1.docker.io"].includes(host) ? "docker.io" : host;
  } catch { return ""; }
}

async function helperCredential(helper: string, address: string, signal: AbortSignal): Promise<RegistryCredential | undefined> {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(helper)) throw new Error("Invalid Docker credential helper name");
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(`docker-credential-${helper}`, ["get"], { shell: false, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) { child.kill(); reject(new Error("Docker credential helper output is too large")); }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.once("error", () => reject(signal.aborted ? signal.reason : new Error("Cannot execute Docker credential helper")));
    child.once("close", code => {
      if (signal.aborted) reject(signal.reason);
      else if (code === 0) resolve(stdout);
      else if (/credentials? (?:not found|.*not.*found)|no credentials/iu.test(stdout + stderr)) resolve("");
      else reject(new Error("Docker credential helper failed"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${address}\n`);
  });
  if (!output) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("Invalid Docker credential helper response"); }
  const data = record(parsed);
  if (typeof data?.Username !== "string" || typeof data.Secret !== "string")
    throw new Error("Invalid Docker credential helper response");
  return data.Username === "<token>" ? { identityToken: data.Secret } : { username: data.Username, password: data.Secret };
}

/** Read the same credential sources as Docker, without logging their values. */
export async function dockerRegistryCredential(registry: string, signal: AbortSignal): Promise<RegistryCredential | undefined> {
  signal.throwIfAborted();
  let raw: string;
  try { raw = await readFile(join(process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), "config.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Cannot read Docker credentials");
  }
  let config: Record<string, unknown> | undefined;
  try { config = record(JSON.parse(raw)); } catch { throw new Error("Invalid Docker client configuration"); }
  if (!config) throw new Error("Invalid Docker client configuration");
  const canonical = registryHost(registry);
  const helpers = record(config.credHelpers);
  const helperEntry = Object.entries(helpers ?? {}).find(([key]) => registryHost(key) === canonical);
  const helper = helperEntry?.[1] ?? config.credsStore;
  if (helper !== undefined && helper !== "") {
    if (typeof helper !== "string") throw new Error("Invalid Docker credential helper configuration");
    return helperCredential(helper, helperEntry?.[0] ?? (canonical === "docker.io" ? "https://index.docker.io/v1/" : registry), signal);
  }
  const entry = Object.entries(record(config.auths) ?? {}).find(([key]) => registryHost(key) === canonical);
  const auth = record(entry?.[1]);
  if (typeof auth?.identitytoken === "string" && auth.identitytoken) return { identityToken: auth.identitytoken };
  if (typeof auth?.auth !== "string" || !auth.auth) return undefined;
  const decoded = Buffer.from(auth.auth, "base64").toString("utf8");
  const split = decoded.indexOf(":");
  if (split < 0) throw new Error("Invalid Docker registry credentials");
  return { username: decoded.slice(0, split), password: decoded.slice(split + 1) };
}
