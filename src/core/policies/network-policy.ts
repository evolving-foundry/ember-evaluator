import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { EnvironmentSpec } from "../contracts/environment.js";

/** HTTP(S) egress rules; unsupported forms fail closed before resource creation. */
export function normalizeAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(host => typeof host !== "string"))
    throw new Error("allowedHosts must be an array of domain names");
  return [...new Set(value.map((raw: string) => {
    const host = raw.trim().toLowerCase().replace(/\.$/u, "");
    const suffix = host.startsWith("*.") ? host.slice(2) : host;
    const ascii = domainToASCII(suffix);
    if (!ascii || isIP(ascii) || (ascii && isIP(new URL(`http://${ascii}`).hostname)) || ascii.length > 253 || !ascii.split(".").every(label =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) || /[/:@?#\\\s*]/u.test(suffix))
      throw new Error("allowedHosts supports domain names and leading *. wildcards; URLs, IP/CIDR, ports and paths are unsupported");
    return host.startsWith("*.") ? `*.${ascii}` : ascii;
  }))];
}

export function validateNetworkPolicy(network: EnvironmentSpec["network"]): void {
  if (network === undefined || network === "bridge" || network === "host" || network === "none" || network === "model-api") return;
  if (!network || typeof network !== "object" || network.kind !== "allowlist" ||
      Object.keys(network).some(key => key !== "kind" && key !== "allowedHosts"))
    throw new Error("Invalid environment network policy");
  normalizeAllowedHosts(network.allowedHosts);
}
