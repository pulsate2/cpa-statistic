import type { UsageEvent } from "../types";
import { nowIso } from "../lib/time";

interface TokenStats {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cached_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  total_tokens?: number;
}

interface QueuedUsageDetail {
  timestamp?: string;
  latency_ms?: number;
  ttft_ms?: number | null;
  source?: string;
  auth_index?: string;
  tokens?: TokenStats;
  failed?: boolean;
  provider?: string;
  model?: string;
  alias?: string | null;
  reasoning_effort?: string;
  service_tier?: string;
  executor_type?: string;
  endpoint?: string;
  auth_type?: string;
  api_key?: string;
  request_id?: string;
}

export type DecodeResult =
  | { kind: "event"; event: UsageEvent }
  | { kind: "control" }
  | { kind: "invalid"; error: string };

/** Detect CPA metadata control messages (no request_id). */
export function isControlMessage(raw: string): boolean {
  if (raw.includes('"request_id"')) return false;
  const t = raw.trim();
  return (
    t === '{"support_refresh":true}' ||
    t === '{"refresh":true}' ||
    /^{\s*"support_refresh"\s*:\s*true\s*}$/.test(t) ||
    /^{\s*"refresh"\s*:\s*true\s*}$/.test(t)
  );
}

export function decodeUsageMessage(raw: string, fetchedAt = new Date()): DecodeResult {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") {
    return { kind: "invalid", error: "empty message" };
  }
  if (isControlMessage(trimmed)) {
    return { kind: "control" };
  }

  let payload: QueuedUsageDetail;
  try {
    payload = JSON.parse(trimmed) as QueuedUsageDetail;
  } catch (e) {
    return { kind: "invalid", error: e instanceof Error ? e.message : "json parse error" };
  }

  const requestId = (payload.request_id ?? "").trim();
  if (!requestId) {
    // control-like or corrupt
    if (isControlMessage(trimmed)) return { kind: "control" };
    return { kind: "invalid", error: "request_id is required" };
  }

  const tokens = payload.tokens ?? {};
  const apiGroupKey = firstNonEmpty(payload.api_key, payload.provider, payload.endpoint, "unknown");
  const model = firstNonEmpty(payload.model, "unknown");
  let timestamp = (payload.timestamp ?? "").trim();
  if (!timestamp) {
    timestamp = nowIso(fetchedAt);
  } else {
    const d = new Date(timestamp);
    timestamp = Number.isNaN(d.getTime()) ? nowIso(fetchedAt) : d.toISOString();
  }

  const authType = normalizeAuthType(payload.auth_type ?? "");
  const modelAlias = (payload.alias ?? "").toString().trim();

  const event: UsageEvent = {
    eventKey: requestId,
    apiGroupKey,
    provider: (payload.provider ?? "").trim(),
    endpoint: (payload.endpoint ?? "").trim(),
    authType,
    requestId,
    model,
    modelAlias,
    reasoningEffort: (payload.reasoning_effort ?? "").trim(),
    serviceTier: (payload.service_tier ?? "").trim(),
    executorType: (payload.executor_type ?? "").trim(),
    timestamp,
    source: (payload.source ?? "").trim(),
    authIndex: (payload.auth_index ?? "").trim(),
    failed: Boolean(payload.failed),
    latencyMs: Math.max(0, Number(payload.latency_ms) || 0),
    ttftMs: payload.ttft_ms == null ? null : Number(payload.ttft_ms),
    inputTokens: num(tokens.input_tokens),
    outputTokens: num(tokens.output_tokens),
    reasoningTokens: num(tokens.reasoning_tokens),
    cachedTokens: num(tokens.cached_tokens),
    cacheReadTokens: num(tokens.cache_read_tokens),
    cacheCreationTokens: num(tokens.cache_creation_tokens),
    totalTokens: num(tokens.total_tokens),
  };

  // If total missing, derive a conservative total
  if (!event.totalTokens) {
    event.totalTokens =
      event.inputTokens + event.outputTokens + event.reasoningTokens + event.cacheReadTokens;
  }

  return { kind: "event", event };
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function firstNonEmpty(...vals: Array<string | undefined | null>): string {
  for (const v of vals) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return "";
}

function normalizeAuthType(value: string): string {
  const t = value.trim().toLowerCase();
  if (t === "api_key") return "apikey";
  return t;
}
