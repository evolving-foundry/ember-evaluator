import type { ErrorCause, ErrorDetails } from "../contracts/errors.js";
import type { Failure, Phase } from "../contracts/result.js";
import { redactDiagnostic } from "./diagnostics.js";
import { EvaluatorError } from "./evaluator-error.js";
import { ERROR_CODES, isErrorCode, type ErrorCode } from "./registry.js";
import { identifyNetworkFailure } from "./network-failure.js";

export type ErrorContext = {
  phase: Phase;
  component?: string;
  operation?: string;
  fallbackCode?: ErrorCode;
  secrets?: readonly string[];
  cancellation?: "user" | "agent" | "infrastructure";
};

/** Read data properties only: never invoke arbitrary getters on third-party errors. */
function own(value: unknown, key: string): unknown {
  if (value instanceof DOMException && (key === "name" || key === "message")) return value[key];
  return value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/** Explicit outer code only; inferred diagnostics and nested causes cannot grant task-local recovery. */
export function declaredErrorCode(error: unknown): ErrorCode | undefined {
  const code = own(error, "code");
  if (isErrorCode(code)) return code;
  return undefined;
}
function chain(error: unknown): unknown[] {
  const result: unknown[] = [];
  const visit = (item: unknown, depth: number) => {
    if (result.length >= 16 || depth >= 8 || result.includes(item)) return;
    result.push(item);
    const cause = own(item, "cause");
    if (cause !== undefined) visit(cause, depth + 1);
    const errors = own(item, "errors");
    if (item instanceof AggregateError && Array.isArray(errors)) for (const child of errors.slice(0, 8)) visit(child, depth + 1);
  };
  visit(error, 0);
  return result;
}
function strings(values: unknown[], key: string): string[] {
  return values.map(value => own(value, key)).filter((value): value is string => typeof value === "string");
}
function timeout(values: unknown[]): boolean {
  return strings(values, "name").some(name => name === "TimeoutError" || name === "APITimeoutError") ||
    strings(values, "code").some(code => /TIMEOUT|TIMEDOUT/u.test(code));
}
function phaseCode(phase: Phase): ErrorCode {
  return ({ prepare: "TASK_DATA_INVALID", install: "ENV_RUNTIME_INSTALL_FAILED", environment: "ENV_PREPARATION_FAILED",
    solve: "INTERNAL_ERROR", transfer: "TRANSFER_FAILED", verify: "VERIFY_EXEC_FAILED",
    collect: "ARTIFACT_COLLECTION_INCOMPLETE", cleanup: "CLEANUP_FAILED", store: "STORE_WRITE_FAILED" } as const)[phase];
}

function selectCode(values: unknown[], context: ErrorContext): ErrorCode {
  if (context.cancellation === "user") return "RUN_CANCELLED";
  if (context.cancellation === "agent") return "SOLVER_AGENT_TIMEOUT";
  if (context.cancellation === "infrastructure") return "RAY_HEARTBEAT_TIMEOUT";
  const codes = strings(values, "code");
  const critical = codes.find(code => isErrorCode(code) && ["abort_run", "stop_dispatch"].includes(ERROR_CODES[code].action));
  if (critical && isErrorCode(critical)) return critical;
  if (identifyNetworkFailure(values, context)) {
    // Build downloads rely on the package manager's own retries. Do not rerun
    // an entire task when its image build exhausts those download attempts.
    const build = context.operation === "build" || codes.includes("ENV_IMAGE_BUILD_FAILED") ||
      values.some(value => own(own(value, "details"), "operation") === "build");
    return build ? "ENV_IMAGE_BUILD_FAILED" : "NETWORK_FAILURE";
  }
  const canonical = codes.find(isErrorCode);
  // Operation wrappers may contain a more precise registered cause.
  const generic = ["INTERNAL_ERROR", "SOLVER_RESULT_INCOMPLETE", "ENV_PREPARATION_FAILED", "ENV_RUNTIME_INSTALL_FAILED", "TRANSFER_FAILED", "ENV_IMAGE_PULL_FAILED", "ENV_IMAGE_BUILD_FAILED"];
  const specific = codes.find(code => isErrorCode(code) && !generic.includes(code));
  if (specific && isErrorCode(specific)) return specific === "NETWORK_FAILURE" ? phaseCode(context.phase) : specific;
  const message = strings(values, "message").join("\n");
  const diagnostics = [...codes, ...strings(values, "name"), message].join("\n");
  const timedOut = timeout(values) || /\b(?:APITimeoutError|TimeoutError|ETIMEDOUT|ESOCKETTIMEDOUT)\b|deadline exceeded|exceeded its task-specific time limit|stream idle timeout|operation was aborted due to timeout/iu.test(message);
  if (context.phase === "cleanup") return timedOut ? "CLEANUP_TIMEOUT" : "CLEANUP_FAILED";
  // Docker echoes RUN recipes, including error strings in branches which never
  // ran. Only recognize "unsupported architecture" as an emitted diagnostic.
  const unsupportedArchitecture = /(?:^|\n)\s*(?:ENV_PREPARATION_FAILED:\s*)?(?:#\d+\s+\d+(?:\.\d+)?\s+)?(?:(?:error|fatal):\s*)?unsupported architecture\b/iu.test(message);
  if (unsupportedArchitecture || /no matching manifest|no match for platform|does not provide the specified platform|exec format error|platform.*does not match/iu.test(message)) return "ENV_ARCH_UNSUPPORTED";
  if (/ENOSPC|no space left on device|cannot allocate memory|pids limit|resource temporarily unavailable/iu.test(diagnostics)) return "ENV_RESOURCE_EXHAUSTED";
  if (/cannot connect to the docker daemon|is the docker daemon running/iu.test(message)) return "ENV_DOCKER_DAEMON_UNAVAILABLE";
  // Model diagnostics are interpreted only at a model/solve boundary; registry
  // HTTP 403/429 must never be confused with a model rejection.
  if (context.phase === "solve" || context.component === "model") {
    const statuses = values.map(value => own(value, "status") ?? own(value, "statusCode"));
    const hasStatus = (...wanted: number[]) => statuses.some(status => typeof status === "number" && wanted.includes(status));
    if (/insufficient_quota|quota[ _-]exceeded|credit.*exhaust|billing.*limit/iu.test(diagnostics)) return "MODEL_QUOTA_EXHAUSTED";
    if (hasStatus(401, 403) || /AuthenticationError|PermissionDeniedError|\bauthentication (?:failed|failure)\b|invalid[ _-]?api[ _-]?key|unauthorized|\bforbidden\b|HTTP\s+(?:401|403)\b/iu.test(diagnostics)) return "MODEL_AUTH_FAILED";
    if (hasStatus(429) || /HTTP\s+429\b|RateLimitError|rate[ _-]?limit|too many requests/iu.test(diagnostics)) return "MODEL_RATE_LIMIT";
    if (/CONTEXT_WINDOW_EXCEEDED|context[_ ]length[_ ]exceeded|maximum context length/iu.test(diagnostics)) return "MODEL_CONTEXT_LIMIT";
    if (hasStatus(400, 404, 413, 422) || /BadRequestError|HTTP\s+(?:400|404|413|422)\b/iu.test(diagnostics)) return "MODEL_REQUEST_INVALID";
    if (hasStatus(408)) return "MODEL_UPSTREAM_TIMEOUT";
    if (timedOut) return "MODEL_UPSTREAM_TIMEOUT";
    if (hasStatus(500, 502, 503, 504) || /APIConnectionError|ServerDisconnectedError|TransferEncodingError|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|Response payload is not completed|HTTP\s+5\d\d\b/iu.test(diagnostics)) return "MODEL_UNAVAILABLE";
  }
  if (timedOut) {
    if (context.operation === "pull") return "ENV_IMAGE_PULL_TIMEOUT";
    if (context.operation === "build") return "ENV_IMAGE_BUILD_TIMEOUT";
    if (context.phase === "verify") return "VERIFY_TIMEOUT";
    if (context.phase === "transfer") return "TRANSFER_TIMEOUT";
    if (context.phase === "solve") return "SOLVER_AGENT_TIMEOUT";
    if (["prepare", "environment", "install"].includes(context.phase) && context.component !== "source") return "ENV_PREPARATION_TIMEOUT";
  }
  if (canonical === "ENV_PREPARATION_FAILED") {
    if (context.operation === "pull") return "ENV_IMAGE_PULL_FAILED";
    if (context.operation === "build") return "ENV_IMAGE_BUILD_FAILED";
    if (context.operation === "create" || context.operation === "start") return "ENV_CONTAINER_START_FAILED";
  }
  if (canonical) return canonical;
  if (context.component === "config") return "CONFIG_INVALID";
  if (context.component === "source") return "DATA_FETCH_FAILED";
  if (context.component === "report") return "REPORT_FAILED";
  if (context.operation === "pull") return "ENV_IMAGE_PULL_FAILED";
  if (context.operation === "build") return "ENV_IMAGE_BUILD_FAILED";
  if (context.operation === "create" || context.operation === "start") return "ENV_CONTAINER_START_FAILED";
  if (context.fallbackCode && isErrorCode(context.fallbackCode)) return context.fallbackCode;
  if (context.component === "scheduler") return "SCHEDULER_UNAVAILABLE";
  return phaseCode(context.phase);
}

/** Classify external diagnostics; framework exceptions already carry registered codes. */
export function classifyError(error: unknown, context: ErrorContext): Failure {
  const values = chain(error);
  const code = selectCode(values, context);
  const policy = ERROR_CODES[code];
  const safe = (value: string) => {
    const redacted = redactDiagnostic(value, context.secrets);
    // Package installation output can be very long; the failing build step is
    // usually at the end. Preserve it without increasing persisted field limits.
    return context.operation === "build" && redacted.length > 2048
      ? `${redacted.slice(0, 512)}\n[... build output truncated ...]\n${redacted.slice(-1500)}`
      : redacted.slice(0, 2048);
  };
  const originalCode = values.map(value => own(value instanceof EvaluatorError ? value.details : value, "originalCode"))
    .find((value): value is string => typeof value === "string") ?? strings(values, "code")[0] ?? context.fallbackCode;
  const originalName = strings(values, "name")[0];
  const details: ErrorDetails = {};
  if (context.component) details.component = safe(context.component);
  if (context.operation) details.operation = safe(context.operation);
  if (originalCode && originalCode !== code) details.originalCode = safe(originalCode);
  if (originalName) details.originalName = safe(originalName);
  for (const value of values) {
    const source = value instanceof EvaluatorError ? value.details : value;
    for (const key of ["component", "operation", "originalCode", "originalName", "signal", "service", "containerId", "logPath", "assetPath", "cpusetCpus", "networkStage", "networkReason", "networkEvidence"] as const) {
      const field = own(source, key);
      if (details[key] === undefined && typeof field === "string") details[key] = safe(field);
    }
    for (const key of ["exitCode", "httpStatus", "retryAfterMs"] as const) {
      const field = own(source, key) ?? (key === "httpStatus" ? own(value, "status") ?? own(value, "statusCode") : undefined);
      if (details[key] === undefined && typeof field === "number" && Number.isSafeInteger(field) &&
        (key === "exitCode" || (field >= 0 && field <= (key === "retryAfterMs" ? 86_400_000 : 599)))) details[key] = field;
    }
    for (const key of ["requestedCpus", "availableCpus"] as const) {
      const field = own(source, key);
      if (details[key] === undefined && typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= 65_536 &&
        (key === "requestedCpus" || Number.isSafeInteger(field))) details[key] = field;
    }
    const retryAfter = own(own(value, "headers"), "retry-after");
    if (details.retryAfterMs === undefined && typeof retryAfter === "string" && /^\d+(?:\.\d+)?$/u.test(retryAfter))
      details.retryAfterMs = Math.min(86_400_000, Math.ceil(Number(retryAfter) * 1000));
  }
  const network = code === "NETWORK_FAILURE" ? identifyNetworkFailure(values, context) : null;
  if (network) for (const [key, value] of Object.entries(network)) Object.assign(details, { [key]: typeof value === "string" ? safe(value) : value });
  const causes: ErrorCause[] = values.slice(1).map(value => {
    const message = own(value, "message");
    const cause: ErrorCause = { message: safe(typeof message === "string" ? message : typeof value === "string" ? value : "Unknown cause") };
    const rawCode = own(value, "code"), name = own(value, "name");
    if (typeof rawCode === "string") cause.code = safe(rawCode);
    if (typeof name === "string") cause.name = safe(name);
    return cause;
  });
  const raw = own(error, "message");
  const message = safe(typeof raw === "string" ? raw : typeof error === "string" ? error : "Unknown error");
  return { phase: context.phase, code, message, schemaVersion: 1, category: policy.category, scope: policy.scope,
    severity: code === "SOLVER_AGENT_TIMEOUT" || code === "RUN_CANCELLED" ? "info" : "error",
    retryable: false, action: policy.action,
    hint: policy.hint, details, causes };
}

export function failureMessage(failure: Failure): string {
  return `${failure.code}: ${failure.message}` + (failure.causes ?? []).map(cause =>
    `\nCaused by: ${cause.code ? `${cause.code}: ` : ""}${cause.message}`).join("");
}

export function normalizeFailure(failure: Failure, secrets?: readonly string[]): Failure {
  const normalized = classifyError(new EvaluatorError(failure.code, failure.message, failure.details),
    { phase: failure.phase, ...(secrets ? { secrets } : {}) });
  normalized.causes = (failure.causes ?? []).slice(0, 15).map(cause => ({
    message: redactDiagnostic(cause.message, secrets).slice(0, 2048),
    ...(cause.code ? { code: redactDiagnostic(cause.code, secrets).slice(0, 2048) } : {}),
    ...(cause.name ? { name: redactDiagnostic(cause.name, secrets).slice(0, 2048) } : {}),
  }));
  normalized.severity = failure.severity ?? normalized.severity;
  if (failure.details?.originalName === undefined) delete normalized.details.originalName;
  return normalized;
}
