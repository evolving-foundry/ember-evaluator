import { expect, test } from "vitest";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SHELL_TOOL_POLICY,
  enforceShellTimeout,
  parseShellToolPolicy,
  resolveShellTimeout,
} from "../../src/runtimes/pi/tool-policy.js";

test("resolveShellTimeout applies the default and clamps model-requested timeouts", () => {
  const policy = { shellTimeoutSeconds: 180, shellMaxTimeoutSeconds: 600 };
  expect(resolveShellTimeout(undefined, policy)).toBe(180);
  expect(resolveShellTimeout(5, policy)).toBe(5);
  expect(resolveShellTimeout(600, policy)).toBe(600);
  expect(resolveShellTimeout(100000, policy)).toBe(600);
});

test("parseShellToolPolicy accepts both bounds and rejects invalid shapes", () => {
  expect(parseShellToolPolicy({ shellTimeoutSeconds: 120, shellMaxTimeoutSeconds: 300 }, "policy")).toEqual({
    shellTimeoutSeconds: 120,
    shellMaxTimeoutSeconds: 300,
  });
  expect(() => parseShellToolPolicy({ shellTimeoutSeconds: 120 }, "policy")).toThrow(/shellMaxTimeoutSeconds/);
  expect(() => parseShellToolPolicy({ shellTimeoutSeconds: -1, shellMaxTimeoutSeconds: 300 }, "policy")).toThrow(
    /shellTimeoutSeconds/,
  );
  expect(() => parseShellToolPolicy({ shellTimeoutSeconds: 300, shellMaxTimeoutSeconds: 120 }, "policy")).toThrow(
    /shellMaxTimeoutSeconds/,
  );
  expect(() => parseShellToolPolicy("180", "policy")).toThrow(/object/);
});

test("enforceShellTimeout injects the resolved timeout into every exec call", async () => {
  const seen: Array<number | undefined> = [];
  const base: BashOperations = {
    async exec(_command, _cwd, options) {
      seen.push(options.timeout);
      return { exitCode: 0 };
    },
  };
  const operations = enforceShellTimeout(base, DEFAULT_SHELL_TOOL_POLICY);
  await operations.exec("true", "/work", { onData: () => {} });
  await operations.exec("true", "/work", { onData: () => {}, timeout: 5 });
  await operations.exec("true", "/work", { onData: () => {}, timeout: 999999 });
  expect(seen).toEqual([180, 5, 600]);
});
