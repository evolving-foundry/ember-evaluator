import { connect } from "node:net";
import { connect as connectTls } from "node:tls";

/** OpenSSH ProxyCommand: keep SSH authentication and host-key checks in OpenSSH. */
const [host, port] = process.argv.slice(2);
const raw = process.env.EVALUATOR_SSH_PROXY;
if (!host || !/^[A-Za-z0-9.:[\]-]+$/u.test(host) || !port || !/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535 || !raw)
  throw new Error("SSH proxy requires a target host, port and proxy configuration");
const proxy = new URL(raw);
if (!["http:", "https:"].includes(proxy.protocol)) throw new Error("SSH proxy must use HTTP(S)");
const options = { host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80)) };
const socket = proxy.protocol === "https:" ? connectTls({ ...options, servername: proxy.hostname, rejectUnauthorized: true }) : connect(options);
const timer = setTimeout(() => socket.destroy(new Error("SSH proxy connection timed out")), 30_000);
socket.once(proxy.protocol === "https:" ? "secureConnect" : "connect", () => {
  const token = proxy.username || proxy.password ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n` : "";
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${token}\r\n`);
});
let buffered = Buffer.alloc(0);
const handshake = (chunk: Buffer) => {
  buffered = Buffer.concat([buffered, chunk]);
  const boundary = buffered.indexOf("\r\n\r\n");
  if (boundary < 0) { if (buffered.length > 65536) socket.destroy(new Error("SSH proxy response too large")); return; }
  if (!/^HTTP\/1\.[01] 200\b/u.test(buffered.toString("ascii", 0, boundary))) { socket.destroy(new Error("SSH proxy refused CONNECT")); return; }
  clearTimeout(timer);
  socket.removeListener("data", handshake);
  process.stdout.write(buffered.subarray(boundary + 4));
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
};
socket.on("data", handshake);
socket.on("error", () => { clearTimeout(timer); process.stderr.write("SSH proxy connection failed\n"); process.exitCode = 1; socket.destroy(); process.stdin.destroy(); });
socket.on("close", () => { clearTimeout(timer); process.stdin.destroy(); });
