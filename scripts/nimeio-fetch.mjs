/**
 * Patch global fetch so Cloudflare API traffic goes through path proxy:
 *   http://tyfd.kdns.fr/nimeio/{originalUrl}
 *
 * Usage:
 *   NODE_OPTIONS='--import ./scripts/nimeio-fetch.mjs' npx wrangler ...
 */
const PROXY_PREFIX = process.env.NIMEIO_PROXY || "http://tyfd.kdns.fr/nimeio/";

const HOST_RE =
  /(^|\.)cloudflare\.com$|(^|\.)workers\.dev$|(^|\.)r2\.cloudflarestorage\.com$|cloudflarestorage\.com$/i;

function shouldProxy(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

function proxiedUrl(urlString) {
  // Avoid double-wrap
  if (urlString.startsWith(PROXY_PREFIX)) return urlString;
  return PROXY_PREFIX + urlString;
}

const originalFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function nimeioFetch(input, init) {
  let url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input && typeof input === "object" && "url" in input
          ? String(input.url)
          : String(input);

  if (shouldProxy(url)) {
    const next = proxiedUrl(url);
    if (typeof input === "string" || input instanceof URL) {
      return originalFetch(next, init);
    }
    // Request object: rebuild with new URL, keep method/headers/body
    const req = input;
    const headers = new Headers(init?.headers ?? req.headers);
    const method = init?.method ?? req.method;
    // Body can only be read once; prefer init.body
    let body = init?.body;
    if (body === undefined && method && method !== "GET" && method !== "HEAD") {
      try {
        body = await req.arrayBuffer();
      } catch {
        body = undefined;
      }
    }
    return originalFetch(next, {
      ...init,
      method,
      headers,
      body,
      // duplex needed for streaming bodies in some node versions
      duplex: body !== undefined ? "half" : undefined,
    });
  }

  return originalFetch(input, init);
};

console.error(`[nimeio-fetch] proxy enabled → ${PROXY_PREFIX}`);
