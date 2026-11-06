import { expect, test, vi, beforeEach } from "vitest";
import { RayScheduler } from "../../src/plugins/schedulers/ray/scheduler.js";
import type { ImageCleanupNode } from "../../src/core/contracts/image-cleanup.js";

const bridge = vi.hoisted(() => ({ cleanup: vi.fn(), start: vi.fn(), close: vi.fn(), options: {} as Record<string, unknown> }));
vi.mock("../../src/infrastructure/ray/client.js", () => ({ RayClient: class {
  constructor(options: Record<string, unknown>) { bridge.options = options; }
  nodes = ["node-a", "node-b"]; start = bridge.start; close = bridge.close; cleanupImages = bridge.cleanup;
} }));
vi.mock("../../src/infrastructure/provenance/package.js", () => ({ loadPackageDigest: async () => `sha256:${"a".repeat(64)}` }));
beforeEach(() => { vi.clearAllMocks(); });
function scheduler() {
  return new RayScheduler({ endpoint: "auto", pythonExecutable: "python", startupTimeoutMs: 1000,
    heartbeatTimeoutMs: 1000, cancelGraceMs: 100, collector: { host: "unused", port: 0, keyFile: "absent", certFile: "absent", tokenEnv: "ABSENT_TEST_TOKEN" } },
  { services: {}, solverService: "", configDirectory: ".", resolvePath: path => path });
}
const node = (nodeId: string, daemonId = nodeId): ImageCleanupNode => ({ nodeId, daemonId, items: [] });
const environment = { name: "docker", config: {} };
test("Ray image preview runs on all selected nodes without a model service or HTTPS collector", async () => {
  const nodes = [node("node-a"), node("node-b")]; bridge.cleanup.mockResolvedValue(nodes);
  expect(await scheduler().cleanupImages({ all: true, execute: false }, environment, {}, AbortSignal.timeout(1000))).toEqual(nodes);
  expect(bridge.cleanup.mock.calls[0]?.[1]).toEqual(["node-a", "node-b"]);
  expect(bridge.options.imageGuard).toBeUndefined();
  expect(bridge.close).toHaveBeenCalledOnce();
});
test("Ray cleanup previews first and removes only once per shared daemon", async () => {
  bridge.cleanup.mockResolvedValueOnce([node("node-a", "shared-daemon"), node("node-b", "shared-daemon")]).mockResolvedValueOnce([node("node-a", "shared-daemon")]);
  await scheduler().cleanupImages({ all: true, execute: true }, environment, {}, AbortSignal.timeout(1000));
  expect(bridge.cleanup.mock.calls[0]?.[0]).toMatchObject({ request: { execute: false } });
  expect(bridge.cleanup.mock.calls[1]?.[0]).toMatchObject({ request: { execute: true } });
  expect(bridge.cleanup.mock.calls[1]?.[1]).toEqual(["node-a"]);
});
test("a failed node does not prevent cleanup of the reachable node", async () => {
  const failed = { ...node("node-b", ""), error: "Node unavailable" };
  bridge.cleanup.mockResolvedValueOnce([node("node-a"), failed]).mockResolvedValueOnce([node("node-a")]);
  const result = await scheduler().cleanupImages({ all: true, execute: true }, environment, {}, AbortSignal.timeout(1000));
  expect(result).toContainEqual(failed);
  expect(bridge.cleanup.mock.calls[1]?.[1]).toEqual(["node-a"]);
});
test("shared daemons with different ownership records refuse destructive cleanup", async () => {
  bridge.cleanup.mockResolvedValueOnce([{ ...node("node-a", "shared"), inventoryId: "a" }, { ...node("node-b", "shared"), inventoryId: "b" }]);
  const result = await scheduler().cleanupImages({ all: true, execute: true }, environment, {}, AbortSignal.timeout(1000));
  expect(result.every(value => value.error?.includes("different image inventories"))).toBe(true);
  expect(bridge.cleanup).toHaveBeenCalledOnce();
});
test("cancellation after preview never sends a destructive request", async () => {
  const controller = new AbortController();
  bridge.cleanup.mockImplementationOnce(async () => { controller.abort(); return [node("node-a")]; });
  await scheduler().cleanupImages({ all: true, execute: true }, environment, {}, controller.signal);
  expect(bridge.cleanup).toHaveBeenCalledOnce();
  expect(bridge.close).toHaveBeenCalledOnce();
});
