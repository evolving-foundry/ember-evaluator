import { expect, test, vi } from "vitest";
import { DSH_VERSION, selectDshVersion } from "../../src/runtimes/dsh/runtime.js";

test("prefers the compatible default without querying npm", async () => {
  const published = vi.fn(async () => ["0.3.0"]);
  expect(await selectDshVersion(">=0.2.2-rc.1 <0.4", published)).toBe(DSH_VERSION);
  expect(published).not.toHaveBeenCalled();
});

test("selects the highest published version compatible with the bundle range", async () => {
  const published = async () => ["0.1.7-rc.2", "0.1.7-alpha.1", "0.2.0-rc.1"];
  expect(await selectDshVersion(">=0.1.7-alpha.1, <0.2", published)).toBe("0.1.7-rc.2");
  await expect(selectDshVersion("> 0.2", published)).rejects.toThrow('no published DSH version satisfies "> 0.2"');
});
