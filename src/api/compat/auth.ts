/** Cookie session auth compatible with original frontend (credentials: include). */

const COOKIE_NAME = "cpa_usage_session";
const SESSION_TTL_SEC = 7 * 24 * 3600;

function sessionSecret(envPassword: string): string {
  return `cpa-stats:${envPassword}`;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function authDisabled(password: string | undefined): boolean {
  return !(password && password.trim());
}

export async function isAuthenticated(request: Request, password: string | undefined): Promise<boolean> {
  if (authDisabled(password)) return true;
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = cookies[COOKIE_NAME];
  if (!token) {
    // Also accept Bearer for API tools
    const auth = request.headers.get("Authorization") || "";
    if (auth.startsWith("Bearer ") && auth.slice(7).trim() === password!.trim()) return true;
    return false;
  }
  const [expStr, sig] = token.split(".");
  const exp = Number(expStr);
  if (!exp || !sig || Date.now() / 1000 > exp) return false;
  const expected = await hmacHex(sessionSecret(password!.trim()), `admin|${exp}`);
  return sig === expected;
}

export async function createSessionCookie(password: string, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const sig = await hmacHex(sessionSecret(password.trim()), `admin|${exp}`);
  const value = encodeURIComponent(`${exp}.${sig}`);
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SEC}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${COOKIE_NAME}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function sessionJson(authenticated: boolean) {
  return {
    authenticated,
    role: authenticated ? "admin" : undefined,
  };
}
