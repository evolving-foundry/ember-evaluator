import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SourceLock } from "../../src/core/contracts/task.js";
import type { DatasetFileSource } from "../../src/infrastructure/datasets/sources/huggingface/snapshot-source.js";
import { OFFICEQA_DATASET_REVISION } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/config.js";

export const fixtureCSV = 'uid,question,answer,source_docs,source_files\nqid_7,What is the receipt?,21.58,private-page-999,private-reference.txt\nqid_9,What is the balance?,"$7,046,001.98",private-page-998,private-other.txt\n';
// A real, minimal one-page PDF, generated locally without benchmark data.
export function fixturePDF(): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const stream = "BT /F1 12 Tf 20 100 Td (Public receipt 21.58) Tj ET\n";
  objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

export async function officeQAFiles(root: string, format: "parsed-json" | "pdf", csv = fixtureCSV) {
  const prefix = format === "pdf" ? "pdfs/" : "parsed_corpus/jsons/";
  const suffix = format === "pdf" ? ".pdf" : ".json";
  const content = format === "pdf" ? fixturePDF() : Buffer.from('{"document":{"elements":[{"type":"text","content":"Public receipt 21.58"}],"pages":[]}}');
  const bytes = new Map<string, Buffer>([["officeqa_pro_v2.csv", Buffer.from(csv)],
    [`${prefix}public-a${suffix}`, content], [`${prefix}public-b${suffix}`, content]]);
  await mkdir(root, { recursive: true });
  const paths = new Map<string, string>();
  for (const [path, data] of bytes) {
    const local = join(root, createHash("sha256").update(path).digest("hex"));
    await writeFile(local, data); paths.set(path, local);
  }
  const lock: SourceLock = { source: "fixture:officeqa", revision: OFFICEQA_DATASET_REVISION,
    files: [...bytes].map(([path, data]) => ({ path, sha256: createHash("sha256").update(data).digest("hex"), origin: `https://fixture.invalid/${path}` })), metadata: {} };
  const source: DatasetFileSource = {
    async resolve(previous, signal) {
      signal.throwIfAborted();
      if (previous && JSON.stringify(previous) !== JSON.stringify(lock)) throw new Error("Fixture source changed");
      return structuredClone(lock);
    },
    async file(_lock, path, signal) { signal.throwIfAborted(); const local = paths.get(path); if (!local) throw new Error("Missing file"); return local; },
  };
  return { bytes, paths, lock, source };
}

export async function officeQAHub(bytes: Map<string, Buffer>) {
  const requests: string[] = [];
  const authorizations: string[] = [];
  let status = 200;
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    authorizations.push(req.headers.authorization ?? "");
    if (status !== 200) { res.writeHead(status).end("access denied"); return; }
    if (req.url?.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sha: OFFICEQA_DATASET_REVISION, siblings: [...bytes].map(([rfilename, data]) => ({ rfilename,
        ...(rfilename.endsWith(".csv") ? {} : { lfs: { sha256: createHash("sha256").update(data).digest("hex") } }) })) }));
      return;
    }
    const path = req.url?.split(`/resolve/${OFFICEQA_DATASET_REVISION}/`)[1];
    const data = path ? bytes.get(decodeURIComponent(path)) : undefined;
    if (data) res.end(data); else res.writeHead(404).end("missing");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return { requests, authorizations, endpoint, transport: { apiBase: endpoint, fileBase: endpoint }, deny(code: number) { status = code; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }) };
}
