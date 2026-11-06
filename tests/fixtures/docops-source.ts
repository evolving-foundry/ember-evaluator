import { createServer, type Server } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { gitBlobHash } from "../../src/infrastructure/datasets/sources/github/blob-cache.js";
import type { DocOpsTransport } from "../../plugins/docops/index.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const textFixture = /(?:^|\/)(?:Dockerfile|[^/]+\.(?:json|md|sh|toml|txt))$/u;

async function filesBelow(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(root, path));
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
  }
  return result;
}

export type DocOpsFixtureSource = {
  commit: string;
  requests: Map<string, number>;
  server: Server;
  transport: DocOpsTransport;
};

export async function startDocOpsFixtureSource(root: string): Promise<DocOpsFixtureSource> {
  const blobs = new Map<string, Uint8Array>();
  for (const path of await filesBelow(root)) {
    const bytes = await readFile(resolve(root, ...path.split("/")));
    blobs.set(path, textFixture.test(path) ? Buffer.from(bytes.toString("utf8").replaceAll("\r\n", "\n")) : bytes);
  }
  const tree = {
    truncated: false,
    tree: [...blobs].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
      path,
      sha: gitBlobHash(bytes),
      type: "blob",
      mode: path.endsWith("/test.sh") ? "100755" : "100644",
    })),
  };
  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    requests.set(url.pathname + url.search, (requests.get(url.pathname + url.search) ?? 0) + 1);
    if (url.pathname === "/repos/fixture/docops/commits/main") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ sha: COMMIT }));
      return;
    }
    if (url.pathname === `/repos/fixture/docops/git/trees/${COMMIT}` && url.search === "?recursive=1") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(tree));
      return;
    }
    const prefix = `/fixture/docops/${COMMIT}/`;
    const path = url.pathname.startsWith(prefix) ? decodeURIComponent(url.pathname.slice(prefix.length)) : "";
    const bytes = blobs.get(path);
    if (bytes) {
      response.setHeader("content-length", String(bytes.byteLength));
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("DocOps fixture server did not bind TCP");
  const base = `http://127.0.0.1:${address.port}`;
  return { commit: COMMIT, requests, server, transport: { apiBase: base, rawBase: base } };
}
