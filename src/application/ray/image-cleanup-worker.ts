import { resolve } from "node:path";
import { openPluginRegistry } from "../plugins/open-registry.js";
import { loadPackageDigest } from "../../infrastructure/provenance/package.js";
import { assertWorkerVersions, localizePortableSelection } from "../../infrastructure/ray/protocol.js";
import type { NodeConfig } from "../../infrastructure/ray/node-config.js";
import { expectRecord, expectNonEmptyString } from "../../core/validation/input.js";
import { parseImageCleanupRequest } from "../../infrastructure/ray/image-cleanup.js";

/** Uses the deployed worker and patch; accepts no coordinator filesystem paths or credentials. */
export async function cleanupNodeImages(input: unknown, node: NodeConfig) {
  return withNodeEnvironment(input, node, async (environment, payload) => {
    if (!environment.cleanupImages) throw new Error("Node environment does not support image cleanup");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    try { return await environment.cleanupImages(parseImageCleanupRequest(payload.request), controller.signal); }
    finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
  });
}

export async function guardNodeImages(input: unknown, node: NodeConfig, closed: Promise<void>, ready: () => void) {
  return withNodeEnvironment(input, node, async environment => {
    const release = await environment.acquireImageLease?.(AbortSignal.timeout(30_000));
    try { ready(); await closed; }
    finally { await release?.(); }
  });
}

async function withNodeEnvironment<T>(input: unknown, node: NodeConfig,
  action: (environment: import("../../core/contracts/environment.js").Environment, payload: Record<string, unknown>) => Promise<T>) {
  const payload = expectRecord(input, "image maintenance payload");
  const registry = await openPluginRegistry(node.pluginPatchPath);
  try {
    const expected = expectRecord(payload.pluginVersions, "plugin versions");
    if (Object.values(expected).some(version => typeof version !== "string")) throw new TypeError("Invalid plugin versions");
    assertWorkerVersions(expected as Record<string, string>, registry.pluginVersions,
      expectNonEmptyString(payload.packageDigest, "package digest"), await loadPackageDigest());
    const lookup = (role: string, name: string) => registry.ctx.evaluator.configTransport(role, name);
    const selection = localizePortableSelection(expectRecord(payload.environment, "environment") as unknown as import("../../core/contracts/config.js").Selection,
      "environment", node, lookup);
    const environment = await registry.ctx.evaluator.prepare("environment", selection)({
      services: {}, solverService: "", configDirectory: node.configDirectory,
      resolvePath: path => resolve(node.configDirectory, path), ...(node.pluginPatchPath ? { pluginPatchPath: node.pluginPatchPath } : {}),
    });
    return await action(environment, payload);
  } finally { await registry.dispose(); }
}
