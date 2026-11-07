import { expect, test } from "vitest";
import { formatError, redactDiagnostic, summarizeDiagnostic } from "../../src/core/errors/diagnostics.js";

test("network diagnostics preserve nested and aggregate failure codes without dumping request objects", () => {
  const reset = Object.assign(new Error("connection reset"), { code: "ECONNRESET", syscall: "read", headers: { authorization: "HIDDEN_HEADER" } });
  const dns = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND", hostname: "huggingface.co" });
  const error = new TypeError("fetch failed", { cause: new AggregateError([reset, dns], "connection attempts failed") });
  const text = formatError(error);
  for (const value of ["fetch failed", "ECONNRESET", "ENOTFOUND", "huggingface.co", "read"]) expect(text).toContain(value);
  expect(text).not.toContain("HIDDEN_HEADER");
});

test("diagnostics redact known credentials, URL authentication, query strings and fragments", () => {
  const secret = "private/key";
  const error = new Error(`request https://user:password@example.test/v1?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT ${secret}`, {
    cause: new Error(`encoded credential ${encodeURIComponent(secret)}`),
  });
  const text = formatError(error, [secret]);
  expect(text).toContain("https://example.test/v1");
  expect(text).toContain("[redacted]");
  for (const value of [secret, encodeURIComponent(secret), "password", "PRIVATE_TOKEN", "PRIVATE_FRAGMENT"]) expect(text).not.toContain(value);
  expect(redactDiagnostic("\u001b[31mtest\r")).not.toContain("\u001b");
});

test("diagnostics tolerate thrown primitives and circular error causes", () => {
  expect(formatError(null)).toBe("null");
  expect(formatError("failure")).toBe("failure");
  const error = new Error("outer"); error.cause = error;
  expect(formatError(error)).toContain("outer");
  expect(formatError(error)).toContain("[circular error]");
});

test("URL credential redaction recognizes case-insensitive HTTP schemes", () => {
  const text = redactDiagnostic("HTTPS://user:PRIVATE_PASSWORD@example.test/v1?api_key=PRIVATE_QUERY");
  expect(text).toContain("https://example.test/v1");
  expect(text).not.toContain("PRIVATE_PASSWORD");
  expect(text).not.toContain("PRIVATE_QUERY");
});

test("error summaries retain the first message even when it starts with a stack-like word", () => {
  expect(summarizeDiagnostic("At least one task is required")).toBe("At least one task is required");
  expect(summarizeDiagnostic("request failed\n    at internal.js:1\nCaused by: connection refused (code=ECONNREFUSED)"))
    .toBe("request failed → Caused by: connection refused (code=ECONNREFUSED)");
});
