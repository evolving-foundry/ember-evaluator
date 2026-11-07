import type { JsonValue } from "../contracts/task.js";

/** Human-readable diagnostics only; never serialize arbitrary error properties or request headers. */
export function redactDiagnostic(text: string, secrets: readonly string[] = []): string {
  for (const secret of secrets) {
    if (!secret) continue;
    text = text.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return text
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\b(api[ _-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?[^\s"',;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}`;
      } catch {
        return "[invalid URL redacted]";
      }
    })
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Preserve JSON structure while redacting explicitly supplied diagnostic evidence. */
export function redactEvidence(value: JsonValue, secrets: readonly string[] = []): JsonValue {
  if (typeof value === "string") return redactDiagnostic(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactEvidence(item, secrets));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [redactDiagnostic(key, secrets), redactEvidence(item, secrets)]));
  return value;
}

export function formatError(error: unknown, secrets: readonly string[] = []): string {
  const seen = new Set<unknown>();
  const describe = (value: unknown, depth: number): string => {
    if (depth >= 8) return "[error chain truncated]";
    if (value === null || typeof value !== "object") return String(value);
    if (seen.has(value)) return "[circular error]";
    seen.add(value);
    let text = "message" in value && typeof value.message === "string" ? value.message : String(value);
    let fields = "";
    for (const field of ["code", "syscall", "hostname", "address", "port"] as const) {
      const detail: unknown = Object.getOwnPropertyDescriptor(value, field)?.value;
      if (field === "code" && typeof detail === "string" && text.startsWith(`${detail}:`)) continue;
      if (typeof detail === "string" || typeof detail === "number") fields += ` (${field}=${detail})`;
    }
    const newline = text.indexOf("\n");
    text = newline < 0 ? text + fields : text.slice(0, newline) + fields + text.slice(newline);
    if ("cause" in value && value.cause !== undefined) text += `\nCaused by: ${describe(value.cause, depth + 1)}`;
    if (value instanceof AggregateError) {
      for (const child of value.errors.slice(0, 8)) text += `\nRelated error: ${describe(child, depth + 1)}`;
      if (value.errors.length > 8) text += "\n[additional errors truncated]";
    }
    return text;
  };
  return redactDiagnostic(describe(error, 0), secrets);
}

/** Keep the reason and cause chain at info level; verbose launcher/stack frames remain in debug and saved records. */
export function summarizeDiagnostic(text: string): string {
  const lines: string[] = [];
  let inMessage = true;
  for (const line of text
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean)) {
    if (lines.length > 0 && /^(?:at\s|At\s|所在位置|[+~]|CategoryInfo\s*:|FullyQualifiedErrorId\s*:)/.test(line))
      inMessage = false;
    if (/^(?:Caused by:|Related error:)/.test(line)) inMessage = true;
    if (inMessage) lines.push(line);
  }
  const summary = lines.join(" → ");
  return summary.length <= 800 ? summary : `${summary.slice(0, 400)} … ${summary.slice(-350)}`;
}
