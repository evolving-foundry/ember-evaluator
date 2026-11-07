import { beforeEach, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";
const command = vi.hoisted(() => ({ cleanupImages: vi.fn() }));
vi.mock("../../src/application/cleanup.js", () => command);
beforeEach(() => { vi.clearAllMocks(); command.cleanupImages.mockResolvedValue({ preview: true, nodes: [] }); });
async function cli(args: string[]) {
  const out = vi.fn(), error = vi.fn();
  const code = await runCli(args, { out, error });
  return { code, out, error };
}
test.each([
  [["cleanup", "images", "example.yaml"], { file: "example.yaml", all: false, execute: false }],
  [["cleanup", "images", "example.yaml", "--yes"], { file: "example.yaml", all: false, execute: true }],
  [["cleanup", "images", "--all"], { all: true, execute: false }],
  [["cleanup", "images", "example.yaml", "--all", "--yes"], { file: "example.yaml", all: true, execute: true }],
] as const)("cleanup CLI parses %j", async (args, expected) => {
  expect((await cli([...args])).code).toBe(0);
  expect(command.cleanupImages).toHaveBeenCalledWith(expect.objectContaining(expected));
});
test.each([["cleanup", "images"], ["cleanup", "images", "--all", "--all"], ["cleanup", "images", "a.yaml", "--force"], ["cleanup", "images", "--all", "--patch", "x.yaml"], ["cleanup", "images", "a.yaml", "b.yaml"]].map(args => ({ args })))("invalid cleanup syntax is rejected before work: $args", async ({ args }) => {
  expect((await cli(args)).code).toBe(2); expect(command.cleanupImages).not.toHaveBeenCalled();
});
test("cleanup CLI reports partial node failures with exit code 1", async () => {
  command.cleanupImages.mockResolvedValue({ preview: false, nodes: [{ nodeId: "a", daemonId: "", items: [], error: "unreachable" }] });
  const result = await cli(["cleanup", "images", "--all", "--yes"]);
  expect(result.code).toBe(1); expect(result.out).toHaveBeenCalled();
});
