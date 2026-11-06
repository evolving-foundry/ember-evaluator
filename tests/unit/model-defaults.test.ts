import { expect, test } from "vitest";
import { parseModelDefaults, outputLimitFor } from "../../src/runtimes/pi/model-defaults.js";

const defaults = parseModelDefaults({ fallback: { maxTokens: 128000 }, models: {
  "example": { maxTokens: 64000 }, "provider/example": { maxTokens: 96000 },
} });

test("output ceilings follow explicit, provider/model, model, registered metadata, then fallback", () => {
  expect(outputLimitFor(defaults, "example", "provider", 32000, 8000)).toBe(32000);
  expect(outputLimitFor(defaults, "example", "provider", undefined, 8000)).toBe(96000);
  expect(outputLimitFor(defaults, "example", null, undefined, 8000)).toBe(64000);
  expect(outputLimitFor(defaults, "registered", "provider", undefined, 48000)).toBe(48000);
  expect(outputLimitFor(defaults, "unknown", null, undefined, undefined)).toBe(128000);
});

test.each([0, -1, "128000", 1.5, null])("rejects invalid model output ceilings: %j", maxTokens => {
  expect(() => parseModelDefaults({ fallback: { maxTokens }, models: {} })).toThrow(/positive integer/);
});

test("rejects unknown default fields", () => {
  expect(() => parseModelDefaults({ fallback: { maxTokens: 128000, hidden: true }, models: {} })).toThrow();
});
