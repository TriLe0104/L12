/**
 * PXE edge: Next on 127.0.0.1:3001, this process on :3000.
 * HTTP + WebSocket /api and /uploads go to API_PROXY so KVM consoles
 * work when the browser can only reach :3333.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const listenPort = Number(process.env.PORT || 3000);
const nextPort = Number(process.env.NEXT_INNER_PORT || 3001);
const api = new URL(`${(process.env.API_PROXY || "http://127.0.0.1:8001").replace(/\/$/, "")}/`);
const apiPort = Number(api.port || (api.protocol === "https:" ? 443 : 80));

const next = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(nextPort), HOSTNAME: "127.0.0.1" },
  stdio: "inherit",
});
next.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

function targetFor(urlPath) {
  const path = urlPath.split("?")[0] || "/";
  if (path.startsWith("/api") || path.startsWith("/uploads")) {
    return { host: api.hostname, port: apiPort };
  }
  return { host: "127.0.0.1", port: nextPort };
}

const server = http.createServer((req, res) => {
  const t = targetFor(req.url || "/");
  const p = http.request(
    {
      hostname: t.host,
      port: t.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  p.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(err.message);
  });
  req.pipe(p);
});

server.on("upgrade", (req, socket, head) => {
  const t = targetFor(req.url || "/");
  const backend = net.connect(t.port, t.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${key}: ${item}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    backend.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) backend.write(head);
    backend.pipe(socket);
    socket.pipe(backend);
  });
  backend.on("error", () => socket.destroy());
  socket.on("error", () => backend.destroy());
});

server.listen(listenPort, "0.0.0.0", () => {
  process.stdout.write(`l12-edge :${listenPort} → next :${nextPort} api ${api.origin}\n`);
});
