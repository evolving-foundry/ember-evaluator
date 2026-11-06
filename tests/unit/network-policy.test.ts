import { expect, test } from "vitest";
import { normalizeAllowedHosts, validateNetworkPolicy } from "../../src/core/policies/network-policy.js";

test("normalizes explicit domains and subdomain rules without broadening the allowlist", () => {
  expect(normalizeAllowedHosts([" PyPI.org. ", "*.PyPI.org", "pypi.org"])).toEqual(["pypi.org", "*.pypi.org"]);
  expect(normalizeAllowedHosts([])).toEqual([]);
});

test.each(["*", "a.*.com", "https://pypi.org", "pypi.org:443", "pypi.org/path", "127.0.0.1", "2130706433", "0x7f000001", "10.0.0.0/8", "::1", "", "a..com", "a\\b.com"])("rejects unsupported rule %s", rule => {
  expect(() => normalizeAllowedHosts([rule])).toThrow();
});

test("rejects unknown network policy keys before execution", () => {
  expect(() => validateNetworkPolicy(JSON.parse('{"kind":"allowlist","allowedHosts":[],"allowAll":true}'))).toThrow();
});

test("supports an explicit local-host network policy without changing isolated policies", () => {
  for (const policy of ["host", "bridge", "none", "model-api"] as const) expect(() => validateNetworkPolicy(policy)).not.toThrow();
  expect(() => validateNetworkPolicy(JSON.parse('"arbitrary-network"'))).toThrow();
});
