import { beforeEach, afterEach, vi } from "vitest";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";

// Existing protocol fixtures mock web fetch; route only test-owned instances through that fixture.
let restore: (() => void) | undefined;
beforeEach(() => {
  const spy = vi.spyOn(NetworkRuntime.prototype, "fetch").mockImplementation((...args) => globalThis.fetch(...args));
  restore = () => spy.mockRestore();
});
afterEach(() => { restore?.(); restore = undefined; });
