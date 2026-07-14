/**
 * CONNECT MITM → http://tyfd.kdns.fr/nimeio/{url}
 * Critical: resume() the client socket after CONNECT (Node pauses it).
 */
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.MITM_PORT || 18080);
const PATH_PROXY = (process.env.NIMEIO_PROXY || "http://tyfd.kdns.fr/nimeio/").replace(/\/?$/, "/");
const CERT_DIR = join(tmpdir(), "nimeio-mitm-certs");
mkdirSync(CERT_DIR, { recursive: true });
const CA_KEY = join(CERT_DIR, "ca.key");
const CA_CERT = join(CERT_DIR, "ca.crt");

function sh(args) {
  execFileSync("openssl", args, { stdio: "ignore" });
}

function ensureCA() {
  if (existsSync(CA_KEY) && existsSync(CA_CERT)) return;
  sh(["req", "-x509", "-newkey", "rsa:2048", "-keyout", CA_KEY, "-out", CA_CERT, "-days", "3650", "-nodes", "-subj", "/CN=nimeio-mitm-ca"]);
}

const certCache = new Map();
function certForHost(host) {
  if (certCache.has(host)) return certCache.get(host);
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, "_");
  const keyPath = join(CERT_DIR, `${safe}.key`);
  const crtPath = join(CERT_DIR, `${safe}.crt`);
  const csrPath = join(CERT_DIR, `${safe}.csr`);
  const extPath = join(CERT_DIR, `${safe}.ext`);
  if (!existsSync(keyPath) || !existsSync(crtPath)) {
    writeFileSync(extPath, `basicConstraints=CA:FALSE\nsubjectAltName=DNS:${host}\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    sh(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", csrPath, "-subj", `/CN=${host}`]);
    sh(["x509", "-req", "-in", csrPath, "-CA", CA_CERT, "-CAkey", CA_KEY, "-CAcreateserial", "-out", crtPath, "-days", "825", "-extfile", extPath]);
  }
  const pair = { key: readFileSync(keyPath), cert: readFileSync(crtPath) };
  certCache.set(host, pair);
  return pair;
}

function forward(method, targetUrl, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(PATH_PROXY + targetUrl);
    const payload = body?.length ? body : null;
    const hdrs = { ...headers, host: u.host };
    for (const h of ["content-length", "Content-Length", "accept-encoding", "Accept-Encoding", "proxy-connection", "connection", "transfer-encoding", "Proxy-Connection"]) {
      delete hdrs[h];
    }
    if (payload) hdrs["content-length"] = String(payload.length);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: hdrs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 502, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.setTimeout(180000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

function handleHttp(tlsSocket, host) {
  let buf = Buffer.alloc(0);
  const onData = async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    const headerText = buf.subarray(0, idx).toString("utf8");
    const rest = buf.subarray(idx + 4);
    const lines = headerText.split("\r\n");
    const m = lines[0].match(/^([A-Z]+)\s+(\S+)\s+HTTP\//i);
    if (!m) {
      tlsSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(":");
      if (c > 0) headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
    }
    const cl = Number(headers["content-length"] || 0);
    if (rest.length < cl) return;
    // one request per connection for simplicity
    tlsSocket.off("data", onData);
    const body = rest.subarray(0, cl);
    let path = m[2];
    if (path.startsWith("http")) {
      const u = new URL(path);
      path = u.pathname + u.search;
    }
    const targetUrl = `https://${host}${path}`;
    process.stderr.write(`[mitm] ${m[1]} ${targetUrl}\n`);
    try {
      const upHeaders = { ...headers };
      delete upHeaders.host;
      delete upHeaders["content-length"];
      const resp = await forward(m[1].toUpperCase(), targetUrl, upHeaders, body);
      const rh = { ...resp.headers };
      delete rh["transfer-encoding"];
      delete rh["content-encoding"];
      rh["content-length"] = String(resp.body.length);
      rh["connection"] = "close";
      let out = `HTTP/1.1 ${resp.status} OK\r\n`;
      for (const [k, v] of Object.entries(rh)) {
        if (v == null) continue;
        if (Array.isArray(v)) for (const item of v) out += `${k}: ${item}\r\n`;
        else out += `${k}: ${v}\r\n`;
      }
      out += "\r\n";
      tlsSocket.write(out);
      tlsSocket.write(resp.body);
      tlsSocket.end();
    } catch (e) {
      process.stderr.write(`[mitm] forward err: ${e}\n`);
      tlsSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  };
  tlsSocket.on("data", onData);
  tlsSocket.on("error", (e) => process.stderr.write(`[mitm] tls err: ${e.message}\n`));
}

ensureCA();

const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("ok\n");
});

server.on("connect", (req, socket, head) => {
  const host = (req.url || "").split(":")[0];
  process.stderr.write(`[mitm] CONNECT ${req.url}\n`);
  socket.on("error", (e) => process.stderr.write(`[mitm] client: ${e.message}\n`));

  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  // Node HTTP server pauses sockets; resume so TLS ClientHello can flow.
  socket.resume();

  const creds = certForHost(host);
  const tlsSocket = new tls.TLSSocket(socket, {
    isServer: true,
    key: creds.key,
    cert: creds.cert,
    // Don't reject anything
    rejectUnauthorized: false,
  });

  if (head && head.length) {
    // Early data before TLSSocket attached — push into tls layer
    tlsSocket.unshift(head);
  }

  tlsSocket.on("secure", () => {
    process.stderr.write(`[mitm] secure ${host}\n`);
  });
  tlsSocket.on("error", (e) => {
    process.stderr.write(`[mitm] handshake/tls error ${host}: ${e.message}\n`);
  });

  handleHttp(tlsSocket, host);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[mitm] up 127.0.0.1:${PORT} → ${PATH_PROXY}\n`);
});
