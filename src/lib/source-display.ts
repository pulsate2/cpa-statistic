/**
 * Public "Source" column for usage events.
 * AI Provider (apikey) events often put the upstream API key in `source`;
 * the UI should show provider name, not the key.
 * Aligned with cpa-usage-keeper usageEventPublicSource fallbacks
 * (identity alias when available; apikey → provider; oauth → source).
 */

import { redactSensitiveValue } from "./redact";

export type EventSourceFields = {
  auth_type?: string | null;
  provider?: string | null;
  source?: string | null;
  auth_index?: string | null;
};

export type PublicEventSource = {
  /** Browser-facing label */
  source: string;
  /** Stable filter identity (prefer auth_index) */
  source_raw: string;
  /** Frontend hint: ai_provider | auth_file | ... */
  source_type: string;
  /** Filter dropdown value (auth_index or raw source) */
  identity: string;
};

function trim(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function normalizeAuthType(value: string): string {
  const t = value.trim().toLowerCase();
  if (t === "api_key") return "apikey";
  return t;
}

/** Heuristic: looks like a secret/key rather than a human label or file path. */
export function looksLikeSecretToken(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (s.includes("/") || s.includes("\\") || s.includes("@") && s.includes(".")) {
    // auth file path or email-like — not a bare key
    if (s.includes("/") || s.includes("\\")) return false;
  }
  if (/^(sk|pk|rk|ak|fw|or|key)[-_]/i.test(s)) return true;
  if (s.length >= 20 && /^[A-Za-z0-9_\-+/=.]+$/.test(s) && !/\s/.test(s)) return true;
  return false;
}

export function resolvePublicEventSource(row: EventSourceFields): PublicEventSource {
  const authType = normalizeAuthType(trim(row.auth_type));
  const provider = trim(row.provider);
  const rawSource = trim(row.source);
  const authIndex = trim(row.auth_index);
  const identity = authIndex || rawSource || provider || "unknown";

  const isApiKeyAuth =
    authType === "apikey" || (Boolean(provider) && looksLikeSecretToken(rawSource) && authType !== "oauth");

  let source_type = "";
  if (authType === "apikey" || isApiKeyAuth) source_type = "ai_provider";
  else if (authType === "oauth") source_type = "auth_file";
  else if (authType) source_type = authType;

  let display: string;
  if (isApiKeyAuth) {
    // AI Provider: show name, never the lookup key
    if (provider) {
      display = provider;
    } else if (rawSource && !looksLikeSecretToken(rawSource)) {
      display = rawSource;
    } else if (rawSource) {
      display = redactSensitiveValue(rawSource);
    } else {
      display = authIndex || "unknown";
    }
  } else {
    // OAuth / Auth File: show source path or name
    if (rawSource) {
      display = looksLikeSecretToken(rawSource) ? redactSensitiveValue(rawSource) : rawSource;
    } else if (provider) {
      display = provider;
    } else {
      display = authIndex || "unknown";
    }
  }

  return {
    source: display,
    source_raw: identity,
    source_type,
    identity,
  };
}
