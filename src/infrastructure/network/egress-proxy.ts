/** Embedded in the existing gateway image; task containers have no direct network. */
export const egressProxySource = String.raw`import { connect as tcpConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
function installEgressProxy(server, initialHosts) {
  let hosts = initialHosts;
  const connections = new Set();
  const allowed = hostname => {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    return hosts !== null && hosts.some(rule => rule.startsWith("*.")
      ? host !== rule.slice(2) && host.endsWith(rule.slice(1)) : host === rule);
  };
  const track = socket => { connections.add(socket); socket.once("close", () => connections.delete(socket)); return socket; };
  const deny = socket => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  const proxyFor = hostname => {
    const bypass = (process.env.NO_PROXY ?? process.env.no_proxy ?? "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
    if (bypass.some(rule => rule === "*" || hostname === rule || hostname.endsWith(rule.startsWith(".") ? rule : "." + rule))) return null;
    const value = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
    return value ? new URL(value) : null;
  };
  server.on("connect", (request, socket, head) => {
    track(socket);
    let target;
    try {
      target = new URL("https://" + request.url);
      if (target.username || target.password || target.pathname !== "/" || target.search || target.hash ||
          !allowed(target.hostname) || !/^[^/?#@]+:\d+$/.test(request.url)) return deny(socket);
    } catch { return deny(socket); }
    let upstream;
    let pending;
    const ready = (connected, extra = Buffer.alloc(0)) => {
      upstream = track(connected);
      if (socket.destroyed) { upstream.destroy(); return; }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (extra.length) socket.write(extra);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
    };
    socket.on("error", () => upstream?.destroy());
    socket.on("close", () => { upstream?.destroy(); pending?.destroy(); });
    try {
      const proxy = proxyFor(target.hostname);
      if (proxy) {
        if (!["http:", "https:"].includes(proxy.protocol)) return deny(socket);
        const headers = {};
        if (proxy.username || proxy.password) headers["proxy-authorization"] = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
        pending = (proxy.protocol === "https:" ? httpsRequest : httpRequest)(new URL(proxy.origin), {
          method: "CONNECT", path: target.hostname + ":" + (target.port || "443"), headers, timeout: 30000,
        });
        pending.on("connect", (response, connected, extra) => {
          if (response.statusCode !== 200) { connected.destroy(); socket.destroy(); return; }
          ready(connected, extra);
        });
        pending.on("response", response => { response.resume(); socket.destroy(); });
        pending.on("error", () => socket.destroy());
        pending.on("timeout", () => pending.destroy());
        pending.end();
      } else {
        const connected = track(tcpConnect({ host: target.hostname, port: Number(target.port || 443) }));
        upstream = connected;
        connected.setTimeout(30000, () => { if (connected.connecting) connected.destroy(); });
        connected.on("error", () => socket.destroy());
        connected.once("connect", () => { connected.setTimeout(0); ready(connected); });
      }
    } catch { socket.destroy(); }
  });
  return {
    allowed,
    track,
    forward(request, response, target, headers) {
      const proxy = proxyFor(target.hostname);
      if (proxy && !["http:", "https:"].includes(proxy.protocol)) { response.writeHead(502); response.end(); return; }
      const destination = proxy ? new URL(proxy.origin) : target;
      const outgoingHeaders = { ...headers, host: target.host };
      if (proxy && (proxy.username || proxy.password)) outgoingHeaders["proxy-authorization"] = "Basic " + Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password)).toString("base64");
      // Preserve compressed bodies and their headers; fetch would decompress
      // the body while retaining upstream Content-Encoding/Content-Length.
      const upstream = (destination.protocol === "https:" ? httpsRequest : httpRequest)(destination, {
        method: request.method, path: proxy ? target.href : target.pathname + target.search,
        headers: outgoingHeaders, agent: false,
      }, incoming => {
        const excluded = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
        response.writeHead(incoming.statusCode ?? 502, Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !excluded.has(name))));
        incoming.on("error", () => response.destroy());
        incoming.pipe(response);
      });
      upstream.on("socket", socket => track(socket));
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.on("close", () => upstream.destroy());
      request.on("aborted", () => upstream.destroy());
      request.pipe(upstream);
    },
    update(next) {
      hosts = next;
      server.closeAllConnections();
      for (const connection of connections) connection.destroy();
    },
  };
}
`;

export const EGRESS_PROXY_ENV = {
  HTTP_PROXY: "http://127.0.0.1:18080",
  HTTPS_PROXY: "http://127.0.0.1:18080",
  http_proxy: "http://127.0.0.1:18080",
  https_proxy: "http://127.0.0.1:18080",
  ALL_PROXY: "",
  all_proxy: "",
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  NODE_USE_ENV_PROXY: "1",
};
