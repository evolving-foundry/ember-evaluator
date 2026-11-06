import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { parseKernelTimingEvidence, auditKernelTimingSample } from "../../src/plugins/benchmarks/operator/kernel/timing.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/kernel-timing-flow.json", import.meta.url), "utf8")) as { csv: string; trace: string; traceHostDirect: string; traceHostQueued: string };
const hash = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");
const sample = {csvPath: "profile-reference/kernel_details.csv", csvSha256: hash(fixture.csv),
  tracePath: "profile-reference/trace_view.json", traceSha256: hash(fixture.trace),
  warmup: 1, repeat: 2, meanMs: 0.03, rows: [
    {step:0,device:"0",stream:"61",name:"warmup",startUs:1793620535000000,durationUs:900},
    {step:1,device:"0",stream:"61",name:"copy",startUs:1793620535001000,durationUs:10},
    {step:1,device:"0",stream:"61",name:"transpose",startUs:1793620535001010,durationUs:30},
    {step:2,device:"0",stream:"61",name:"copy",startUs:1793620535001050,durationUs:20}]};
const evidence = () => parseKernelTimingEvidence({schemaVersion:2,method:"profiler-flow/v1",reference:sample,
  candidate:{...sample,csvPath:"profile-candidate/kernel_details.csv",tracePath:"profile-candidate/trace_view.json"}});

test("flow evidence audits original CSV and trace with exact large IDs despite wrong CSV steps", () => {
  const parsed = evidence();
  expect(parsed.reference.meanMs).toBe(0.03);
  expect(() => auditKernelTimingSample(parsed.reference, fixture.csv, fixture.trace)).not.toThrow();
  expect(() => auditKernelTimingSample(parsed.reference, fixture.csv.replace(",20\n", ",30\n"), fixture.trace)).toThrow();
  expect(() => auditKernelTimingSample(parsed.reference, fixture.csv, fixture.trace + " ")).toThrow();
});

test("flow audit rejects missing associations and ambiguous framework steps even with matching hashes", () => {
  for (const trace of [fixture.trace.replace('"ph":"f"','"ph":"i"'), fixture.trace.replace('ProfilerStep#2','ProfilerStep#1')]) {
    expect(() => auditKernelTimingSample({...sample,traceSha256:hash(trace)},fixture.csv,trace)).toThrow();
  }
  expect(() => auditKernelTimingSample({...sample,rows:sample.rows.map((r,i)=>i===3?{...r,step:1}:r)},fixture.csv,fixture.trace)).toThrow();
});

test("timing evidence rejects mismatched means, missing steps and mixed devices", () => {
  const valid=evidence();
  for (const reference of [{...sample,meanMs:1},{...sample,rows:sample.rows.slice(1)},
    {...sample,rows:sample.rows.map((r,i)=>i===3?{...r,device:'1'}:r)}]) {
    expect(() => parseKernelTimingEvidence({...valid,reference})).toThrow();
  }
  expect(() => parseKernelTimingEvidence({...valid,candidate:sample})).toThrow();
});

test("Python flow collector rejects incomplete associations without NPU", () => {
  execFileSync("python3", [fileURLToPath(new URL("./test_kernel_timing.py",import.meta.url))], {timeout:5000});
});

test("flow audit supports direct and asynchronous host launch associations", () => {
  for (const trace of [fixture.traceHostDirect, fixture.traceHostQueued]) {
    expect(() => auditKernelTimingSample({...sample,traceSha256:hash(trace)},fixture.csv,trace)).not.toThrow();
  }
});

test("flow audit rejects missing IDs and mixed trace device processes", () => {
  for (const trace of [fixture.trace.replaceAll('"id":1793620535878030300,',''),
    fixture.trace.replace('"pid":20','"pid":21').replace('"pid":20','"pid":21')]) {
    expect(() => auditKernelTimingSample({...sample,traceSha256:hash(trace)},fixture.csv,trace)).toThrow();
  }
});

test("flow audit rejects an unrepresented device target even without task type metadata", () => {
  const csv = fixture.csv.split('\n').filter(line => !line.includes(',transpose,')).join('\n');
  const trace = fixture.trace.replace('"Task Id":42,"Task Type":"AI_VECTOR_CORE"','"Task Id":42');
  const partial = {...sample,csvSha256:hash(csv),traceSha256:hash(trace),meanMs:0.015,rows:sample.rows.filter(r=>r.name!=='transpose')};
  expect(() => auditKernelTimingSample(partial,csv,trace)).toThrow();
});
