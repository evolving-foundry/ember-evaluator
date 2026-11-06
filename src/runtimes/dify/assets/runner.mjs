#!/usr/bin/env node
// Dify harness runner: executes one workflow solve inside the evaluation
// environment (host for local, task container for docker).
//
// stdin:  {"schemaVersion":1,"baseUrl":...,"apiKey":...,"task":...,
//          "appId":...,"attempt":{runId,taskId,attemptId},"outputDir":"..."}
// stdout: exactly one terminal line
//         {"schemaVersion":1,"type":"result","result":{finalText,usage}} or
//         {"schemaVersion":1,"type":"error","code":...,"message":...}
// side effect: trajectory.jsonl / session.jsonl / dify-run-trace.jsonl in outputDir
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

class WorkflowError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
function httpFailureCode(status) {
  if (status === 401 || status === 403) return "MODEL_AUTH_FAILED";
  if (status === 429) return "MODEL_RATE_LIMIT";
  if (status === 408) return "MODEL_UPSTREAM_TIMEOUT";
  if (status >= 400 && status < 500) return "MODEL_REQUEST_INVALID";
  return "MODEL_UNAVAILABLE";
}


const HINT_LINE_RE = /^\[hint:([^\]]+)\]/;
const HINT_KV_RE = /(\w+)=([^;\]]+)/g;

function readStdinJson() {
  return new Promise((resolve, reject) => {
    let buffered = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { buffered += chunk; });
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(buffered)); } catch (error) { reject(error); }
    });
    process.stdin.on("error", reject);
  });
}

function parseHint(text) {
  for (const line of text.split("\n")) {
    const match = HINT_LINE_RE.exec(line.trim());
    if (match) return Object.fromEntries([...match[1].matchAll(HINT_KV_RE)].map(pair => [pair[1], pair[2].trim()]));
  }
  return {};
}

function stripHintLine(text) {
  return HINT_LINE_RE.test(text) ? text.replace(HINT_LINE_RE, "").replace(/^\n+/, "") : text;
}

function numberOr(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

async function observe(body, apiKey) {
  const observation = { runId: null, status: "", outputs: null, error: "", nodes: [], events: [] };
  const response = await fetch(`${body.baseUrl}/v1/workflows/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ inputs: { task: body.task }, response_mode: "streaming", user: "ember-evaluator" }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new WorkflowError(httpFailureCode(response.status), `POST /v1/workflows/run responded ${response.status}: ${text.slice(0, 300)}`, { httpStatus: response.status });
  }
  if (response.body === null) throw new WorkflowError("SOLVER_PROTOCOL_INVALID", "workflow run response has no body");
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line.startsWith("data:") || line.slice(5).trim() === "") continue;
      let event;
      try { event = JSON.parse(line.slice(5).trim()); } catch { throw new WorkflowError("SOLVER_PROTOCOL_INVALID", `unparseable SSE data: ${line.slice(5, 125)}`); }
      const kind = event.event;
      const data = asRecord(event.data);
      const at = new Date().toISOString();
      // Forward only workflow/node labels, never model output or arbitrary SSE data.
      if (["workflow_started", "node_started", "node_finished", "workflow_finished"].includes(kind)) {
        const title = typeof data?.title === "string" ? data.title : "";
        const message = redact(`Dify ${kind}${title ? `: ${title}` : ""}`, apiKey).slice(0, 500);
        process.stdout.write(JSON.stringify({ schemaVersion: 1, type: "activity", activity: { message } }) + "\n");
      }
      if (kind === "workflow_started" && data !== null && typeof data.id === "string") {
        observation.runId = data.id;
        observation.events.push({ type: "dify-workflow-started", at, data: { difyRunId: data.id } });
      } else if (kind === "node_finished" && data !== null) {
        const metadata = asRecord(data.execution_metadata);
        const captured = {
          id: typeof data.id === "string" ? data.id : "",
          index: typeof data.index === "number" ? data.index : 0,
          nodeId: typeof data.node_id === "string" ? data.node_id : "",
          nodeType: typeof data.node_type === "string" ? data.node_type : "",
          title: typeof data.title === "string" ? data.title : "",
          status: typeof data.status === "string" ? data.status : "",
          elapsedTime: numberOr(data.elapsed_time),
          totalTokens: metadata === null ? null : numberOr(metadata.total_tokens),
        };
        observation.nodes.push(captured);
        observation.events.push({ type: "dify-node-finished", at, data: captured });
      } else if (kind === "workflow_finished" && data !== null) {
        observation.status = typeof data.status === "string" ? data.status : "";
        observation.outputs = asRecord(data.outputs);
        observation.error = typeof data.error === "string" ? data.error : "";
        observation.events.push({ type: "dify-workflow-finished", at, data: { difyRunId: typeof data.id === "string" ? data.id : null, status: observation.status } });
      }
    }
  }
  return observation;
}

function finalText(outputs) {
  if (outputs === null) return "";
  if (typeof outputs.report === "string") return outputs.report;
  if (typeof outputs.answer === "string") return outputs.answer;
  return JSON.stringify(outputs);
}

function totalTokens(observation) {
  const values = observation.nodes.map(node => node.totalTokens).filter(value => value !== null);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function redact(text, apiKey) {
  return apiKey === "" ? text : text.replaceAll(apiKey, "[redacted]");
}

async function writeEvidence(input, observation, startedAt, finalTextValue) {
  await mkdir(input.outputDir, { recursive: true });
  const finishedAt = new Date().toISOString();
  const tokens = totalTokens(observation);
  const events = [
    { schemaVersion: 1, key: input.attempt, seq: 1, at: startedAt, type: "start",
      data: { solver: "agentbundle", harness: "dify", taskId: input.attempt.taskId, baseUrl: input.baseUrl, appId: input.appId ?? null } },
    ...observation.events.map((event, index) => ({
      schemaVersion: 1, key: input.attempt, seq: index + 2, at: event.at, type: event.type,
      data: JSON.parse(redact(JSON.stringify(event.data), input.apiKey)),
    })),
    { schemaVersion: 1, key: input.attempt, seq: observation.events.length + 2, at: finishedAt, type: "end",
      data: { status: observation.runId === null ? "lost-protocol" : observation.status, finalTextLength: finalTextValue.length, totalTokens: tokens } },
  ];
  const files = [
    ["trajectory.jsonl", events.map(event => JSON.stringify(event)).join("\n") + "\n"],
    ["session.jsonl", JSON.stringify({ schemaVersion: 1, kind: "dify", difyRunId: observation.runId, appId: input.appId ?? null, baseUrl: input.baseUrl, startedAt, finishedAt }) + "\n"],
    ["dify-run-trace.jsonl",
      JSON.stringify({ schemaVersion: 1, kind: "dify-run-header", attempt: input.attempt, difyRunId: observation.runId, appId: input.appId ?? null, baseUrl: input.baseUrl,
        ...(input.bundleDigest === undefined ? {} : { bundleDigest: input.bundleDigest, installationId: input.installationId, reused: input.reused === true }) }) + "\n" +
      observation.nodes.map(node => JSON.stringify({ kind: "dify-node", ...node })).join("\n") + "\n" +
      JSON.stringify({ kind: "dify-run-summary", difyRunId: observation.runId, status: observation.status, finalTextLength: finalTextValue.length, totalTokens: tokens, error: observation.error }) + "\n"],
  ];
  for (const [name, content] of files) await writeFile(join(input.outputDir, name), content, { encoding: "utf8", mode: 0o644 });
}

const input = await readStdinJson();
const startedAt = new Date().toISOString();
try {
  if (input.schemaVersion !== 1) throw new WorkflowError("SOLVER_PROTOCOL_INVALID", "schemaVersion must be 1");
  const observation = await observe(input, input.apiKey);
  const answer = finalText(observation.outputs);
  await writeEvidence(input, observation, startedAt, answer);
  if (observation.runId === null) throw new WorkflowError("SOLVER_PROTOCOL_INVALID", "workflow stream ended without a workflow_started event");
  if (observation.status !== "succeeded") {
    const detail = observation.error !== "" ? observation.error : `status ${observation.status}`;
    throw new WorkflowError("SOLVER_PROCESS_CRASHED", `workflow ${observation.runId} did not succeed: ${redact(detail, input.apiKey)}`);
  }
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    type: "result",
    result: { finalText: answer, usage: { inputTokens: null, outputTokens: null, totalTokens: totalTokens(observation) } },
  }) + "\n");
} catch (error) {
  const code = error instanceof WorkflowError ? error.code : "INTERNAL_ERROR";
  const details = error instanceof WorkflowError ? error.details : {};
  let cause = error;
  const transport = [];
  for (let depth = 0; depth < 8 && cause !== null && typeof cause === "object"; depth++) {
    const raw = Object.getOwnPropertyDescriptor(cause, "code")?.value;
    if (typeof raw === "string" && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(raw) && !(cause instanceof WorkflowError)) {
      details.originalCode ??= raw;
      transport.push(raw);
    }
    cause = Object.getOwnPropertyDescriptor(cause, "cause")?.value;
  }
  if (transport.length) { details.networkStage = "model-api"; details.networkEvidence = transport.join(" "); }
  const message = redact(error instanceof Error ? error.message : String(error?.message ?? error), input?.apiKey ?? "");
  process.stdout.write(JSON.stringify({ schemaVersion: 1, type: "error", code, message, details }) + "\n");
  process.exit(1);
}
