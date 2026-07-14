import type { Env } from "../../types";
import { resolveTz } from "../../lib/time";
import { getMeta } from "../../ingest/pipeline";
import { redactIfSensitiveLooking, redactSensitiveValue } from "../../lib/redact";

/** Expand range presets used by original frontend. */
export function resolveRangeBounds(
  range: string,
  startParam: string | null,
  endParam: string | null,
  timeZone: string,
  now = new Date(),
): { startIso: string; endIso: string; startBucket: string; endBucket: string; granularity: "hour" | "day"; windowMinutes: number } {
  const tz = timeZone;
  if (range === "custom" && startParam && endParam) {
    const start = new Date(startParam);
    const end = new Date(endParam);
    const mins = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
    const granularity: "hour" | "day" = mins > 48 * 60 ? "day" : "hour";
    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      startBucket: toBucket(start, tz, granularity),
      endBucket: toBucket(end, tz, granularity),
      granularity,
      windowMinutes: mins,
    };
  }

  const hoursMap: Record<string, number> = {
    "4h": 4,
    "8h": 8,
    "12h": 12,
    "24h": 24,
  };

  if (hoursMap[range]) {
    const h = hoursMap[range];
    const start = new Date(now.getTime() - h * 3600 * 1000);
    return {
      startIso: start.toISOString(),
      endIso: now.toISOString(),
      startBucket: toBucket(start, tz, "hour"),
      endBucket: toBucket(new Date(now.getTime() + 3600 * 1000), tz, "hour"),
      granularity: "hour",
      windowMinutes: h * 60,
    };
  }

  if (range === "yesterday") {
    const parts = getTzParts(now, tz);
    // today 00:00 business
    const todayStart = zonedLocalToUtcMs(parts.year, parts.month, parts.day, "00", "00", "00", tz);
    const yStart = todayStart - 24 * 3600 * 1000;
    const yEnd = todayStart;
    return {
      startIso: new Date(yStart).toISOString(),
      endIso: new Date(yEnd).toISOString(),
      startBucket: toBucket(new Date(yStart), tz, "hour"),
      endBucket: toBucket(new Date(yEnd), tz, "hour"),
      granularity: "hour",
      windowMinutes: 24 * 60,
    };
  }

  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    const start = new Date(now.getTime() - days * 24 * 3600 * 1000);
    return {
      startIso: start.toISOString(),
      endIso: now.toISOString(),
      startBucket: toBucket(start, tz, "day"),
      endBucket: toBucket(new Date(now.getTime() + 24 * 3600 * 1000), tz, "day"),
      granularity: "day",
      windowMinutes: days * 24 * 60,
    };
  }

  // today (default)
  const parts = getTzParts(now, tz);
  const todayStart = zonedLocalToUtcMs(parts.year, parts.month, parts.day, "00", "00", "00", tz);
  const todayEnd = todayStart + 24 * 3600 * 1000;
  const windowMinutes = Math.max(1, Math.round((now.getTime() - todayStart) / 60000));
  return {
    startIso: new Date(todayStart).toISOString(),
    endIso: new Date(todayEnd).toISOString(),
    startBucket: toBucket(new Date(todayStart), tz, "hour"),
    endBucket: toBucket(new Date(todayEnd), tz, "hour"),
    granularity: "hour",
    windowMinutes,
  };
}

function toBucket(d: Date, tz: string, g: "hour" | "day"): string {
  const p = getTzParts(d, tz);
  if (g === "day") return `${p.year}-${p.month}-${p.day}T00:00:00`;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00:00`;
}

interface TzParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function getTzParts(date: Date, timeZone: string): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

function zonedLocalToUtcMs(
  year: string,
  month: string,
  day: string,
  hour: string,
  minute: string,
  second: string,
  timeZone: string,
): number {
  const guess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  const parts = getTzParts(new Date(guess), timeZone);
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return guess - (asIfUtc - guess);
}

interface AggRow {
  request_count: number;
  success_count: number;
  failure_count: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
}

interface SeriesRow extends AggRow {
  bucket_start: string;
}

interface PriceRow {
  model: string;
  pricing_style: string;
  prompt_price_per_1m: number;
  completion_price_per_1m: number;
  cache_read_price_per_1m: number;
  cache_write_price_per_1m: number;
  price_multiplier: number;
}

export async function buildUsageOverviewV1(env: Env, url: URL) {
  const tz = resolveTz(env.TZ);
  const range = url.searchParams.get("range") || "8h";
  const bounds = resolveRangeBounds(range, url.searchParams.get("start"), url.searchParams.get("end"), tz);
  const table = bounds.granularity === "hour" ? "usage_hourly_stats" : "usage_daily_stats";

  const summaryRow = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(request_count), 0) AS request_count,
       COALESCE(SUM(success_count), 0) AS success_count,
       COALESCE(SUM(failure_count), 0) AS failure_count,
       COALESCE(SUM(input_tokens), 0) AS input_tokens,
       COALESCE(SUM(output_tokens), 0) AS output_tokens,
       COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
       COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM ${table}
     WHERE bucket_start >= ? AND bucket_start < ?`,
  )
    .bind(bounds.startBucket, bounds.endBucket)
    .first<AggRow>();

  const seriesRows = (
    await env.DB.prepare(
      `SELECT
         bucket_start,
         COALESCE(SUM(request_count), 0) AS request_count,
         COALESCE(SUM(success_count), 0) AS success_count,
         COALESCE(SUM(failure_count), 0) AS failure_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM ${table}
       WHERE bucket_start >= ? AND bucket_start < ?
       GROUP BY bucket_start
       ORDER BY bucket_start ASC`,
    )
      .bind(bounds.startBucket, bounds.endBucket)
      .all<SeriesRow>()
  ).results ?? [];

  const modelRows = (
    await env.DB.prepare(
      `SELECT
         model,
         COALESCE(SUM(request_count), 0) AS request_count,
         COALESCE(SUM(success_count), 0) AS success_count,
         COALESCE(SUM(failure_count), 0) AS failure_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM ${table}
       WHERE bucket_start >= ? AND bucket_start < ?
       GROUP BY model`,
    )
      .bind(bounds.startBucket, bounds.endBucket)
      .all<AggRow & { model: string }>()
  ).results ?? [];

  const prices = (await env.DB.prepare(`SELECT * FROM model_prices`).all<PriceRow>()).results ?? [];
  const priceMap = new Map(prices.map((p) => [p.model, p]));

  const r = summaryRow ?? emptyAgg();
  let totalCost = 0;
  let costAvailable = false;
  for (const m of modelRows) {
    const c = costFor(m, priceMap.get(m.model));
    if (c != null) {
      totalCost += c;
      costAvailable = true;
    }
  }

  const requests: Record<string, number> = {};
  const tokens: Record<string, number> = {};
  const rpm: Record<string, number> = {};
  const tpm: Record<string, number> = {};
  const cost: Record<string, number> = {};
  const cache_read_rate: Record<string, number | null> = {};

  const bucketMinutes = bounds.granularity === "hour" ? 60 : 24 * 60;
  for (const s of seriesRows) {
    const key = s.bucket_start;
    requests[key] = s.request_count;
    tokens[key] = s.total_tokens;
    rpm[key] = s.request_count / bucketMinutes;
    tpm[key] = s.total_tokens / bucketMinutes;
    cost[key] = 0;
    const denom = s.input_tokens + s.cache_read_tokens;
    cache_read_rate[key] = denom > 0 ? s.cache_read_tokens / denom : null;
  }

  const windowMinutes = Math.max(1, bounds.windowMinutes);
  const successRate = r.request_count > 0 ? r.success_count / r.request_count : 1;

  // service health: use hourly success/failure as coarse blocks
  const block_details = seriesRows.map((s) => {
    const total = s.success_count + s.failure_count;
    return {
      start_time: s.bucket_start,
      end_time: s.bucket_start,
      success: s.success_count,
      failure: s.failure_count,
      rate: total > 0 ? s.success_count / total : 1,
    };
  });

  return {
    usage: {
      total_requests: r.request_count,
      success_count: r.success_count,
      failure_count: r.failure_count,
      total_tokens: r.total_tokens,
    },
    summary: {
      request_count: r.request_count,
      token_count: r.total_tokens,
      window_minutes: windowMinutes,
      rpm: r.request_count / windowMinutes,
      tpm: r.total_tokens / windowMinutes,
      total_cost: totalCost,
      cost_available: costAvailable,
      input_tokens: r.input_tokens,
      cache_read_tokens: r.cache_read_tokens,
      cache_creation_tokens: r.cache_creation_tokens,
      reasoning_tokens: r.reasoning_tokens,
    },
    series: {
      requests,
      tokens,
      rpm,
      tpm,
      cost,
      cache_read_rate,
    },
    service_health: {
      total_success: r.success_count,
      total_failure: r.failure_count,
      success_rate: successRate,
      rows: 1,
      columns: Math.max(1, seriesRows.length),
      bucket_seconds: bounds.granularity === "hour" ? 3600 : 86400,
      window_start: bounds.startIso,
      window_end: bounds.endIso,
      block_details,
    },
    timezone: tz,
    range_start: bounds.startIso,
    range_end: bounds.endIso,
    last_synced_at: await getMeta(env.DB, "last_synced_at"),
  };
}

export function emptyRealtime(window = "15m"): Record<string, unknown> {
  return {
    window,
    timezone: "Asia/Shanghai",
    bucket_seconds: window === "60m" ? 120 : window === "30m" ? 60 : 30,
    token_velocity: [],
    response_level: [],
    response_distribution: {
      ttft: { average_line: [], particles: [], total_particles: 0, sampled: false, max_particles: 1000 },
      latency: { average_line: [], particles: [], total_particles: 0, sampled: false, max_particles: 1000 },
    },
    current_usage: {
      models: [] as Array<Record<string, unknown>>,
      api_keys: [],
      auth_files: [],
      ai_providers: [],
    },
    request_level: [],
    cache_level: [],
  };
}

export async function buildAnalysisV1(env: Env, url: URL) {
  const tz = resolveTz(env.TZ);
  const range = url.searchParams.get("range") || "8h";
  const bounds = resolveRangeBounds(range, url.searchParams.get("start"), url.searchParams.get("end"), tz);
  const table = bounds.granularity === "hour" ? "usage_hourly_stats" : "usage_daily_stats";

  const seriesRows = (
    await env.DB.prepare(
      `SELECT
         bucket_start,
         COALESCE(SUM(request_count), 0) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM ${table}
       WHERE bucket_start >= ? AND bucket_start < ?
       GROUP BY bucket_start
       ORDER BY bucket_start ASC`,
    )
      .bind(bounds.startBucket, bounds.endBucket)
      .all<any>()
  ).results ?? [];

  const modelRows = (
    await env.DB.prepare(
      `SELECT
         model,
         COALESCE(SUM(request_count), 0) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM ${table}
       WHERE bucket_start >= ? AND bucket_start < ?
       GROUP BY model
       ORDER BY total_tokens DESC`,
    )
      .bind(bounds.startBucket, bounds.endBucket)
      .all<any>()
  ).results ?? [];

  const keyRows = (
    await env.DB.prepare(
      `SELECT
         api_group_key AS key,
         COALESCE(SUM(request_count), 0) AS request_count,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM ${table}
       WHERE bucket_start >= ? AND bucket_start < ?
       GROUP BY api_group_key
       ORDER BY total_tokens DESC
       LIMIT 50`,
    )
      .bind(bounds.startBucket, bounds.endBucket)
      .all<any>()
  ).results ?? [];

  const prices = (await env.DB.prepare(`SELECT * FROM model_prices`).all<PriceRow>()).results ?? [];
  const priceMap = new Map(prices.map((p) => [p.model, p]));

  const totalTokens = modelRows.reduce((s: number, m: any) => s + Number(m.total_tokens || 0), 0) || 1;

  const token_usage = seriesRows.map((s: any) => {
    const c = null;
    return {
      bucket: s.bucket_start,
      input_tokens: s.input_tokens,
      output_tokens: s.output_tokens,
      cache_read_tokens: s.cache_read_tokens,
      cache_creation_tokens: s.cache_creation_tokens,
      reasoning_tokens: s.reasoning_tokens,
      total_tokens: s.total_tokens,
      requests: s.request_count,
      cost_usd: 0,
      cost_available: false,
    };
  });

  const toComp = (rows: any[], keyField: string, redactKey = false) =>
    rows.map((m) => {
      const cost = keyField === "model" ? costFor(m, priceMap.get(m.model)) : null;
      const raw = String(m[keyField] || m.key || "unknown");
      const display = redactKey ? redactSensitiveValue(raw) : raw;
      return {
        // Browser-facing: mask keys; keep stable masked form as both key & label
        key: display,
        label: display,
        total_tokens: m.total_tokens,
        requests: m.request_count,
        percent: m.total_tokens / totalTokens,
        input_tokens: m.input_tokens,
        output_tokens: m.output_tokens,
        cache_read_tokens: m.cache_read_tokens,
        cache_creation_tokens: m.cache_creation_tokens,
        reasoning_tokens: m.reasoning_tokens,
        cost_usd: cost ?? 0,
        cost_available: cost != null,
      };
    });

  const model_efficiency = modelRows.map((m: any) => {
    const cost = costFor(m, priceMap.get(m.model));
    const req = Math.max(1, m.request_count);
    const denom = m.input_tokens + m.cache_read_tokens;
    return {
      model: m.model,
      requests: m.request_count,
      input_tokens: m.input_tokens,
      output_tokens: m.output_tokens,
      cache_read_tokens: m.cache_read_tokens,
      cache_creation_tokens: m.cache_creation_tokens,
      reasoning_tokens: m.reasoning_tokens,
      total_tokens: m.total_tokens,
      cost_usd: cost ?? 0,
      cost_available: cost != null,
      cost_per_request_usd: (cost ?? 0) / req,
      output_tokens_per_request: m.output_tokens / req,
      cache_read_rate: denom > 0 ? m.cache_read_tokens / denom : 0,
    };
  });

  return {
    granularity: bounds.granularity === "hour" ? "hourly" : "daily",
    timezone: tz,
    range_start: bounds.startIso,
    range_end: bounds.endIso,
    token_usage,
    model_composition: toComp(modelRows, "model", false),
    api_key_composition: toComp(keyRows, "key", true),
    auth_files_composition: [],
    ai_provider_composition: [],
    heatmap: { api_keys: [], api_key_labels: {}, models: [], cells: [] },
    cost_breakdown: {
      uncached_input_cost_usd: 0,
      cache_read_cost_usd: 0,
      cache_write_cost_usd: 0,
      output_cost_usd: 0,
      total_cost_usd: model_efficiency.reduce((s: number, m: any) => s + (m.cost_usd || 0), 0),
      cost_available: model_efficiency.some((m: any) => m.cost_available),
    },
    model_efficiency,
    latency_diagnostics: {
      points: [],
      density: [],
      total_points: 0,
      sampled: false,
      p95_ttft_ms: 0,
      p95_latency_ms: 0,
      max_ttft_ms: 0,
      max_latency_ms: 0,
    },
  };
}

export async function buildEventsV1(env: Env, url: URL) {
  const page = Math.max(1, Number(url.searchParams.get("page") || "1") || 1);
  const pageSize = Math.min(1000, Math.max(1, Number(url.searchParams.get("page_size") || url.searchParams.get("pageSize") || "100") || 100));
  const offset = (page - 1) * pageSize;
  const model = url.searchParams.get("model");
  const result = url.searchParams.get("result") || url.searchParams.get("failed");
  const source = url.searchParams.get("source");

  const where: string[] = [];
  const binds: unknown[] = [];

  // Optional time bounds from range
  const tz = resolveTz(env.TZ);
  const range = url.searchParams.get("range");
  if (range) {
    const bounds = resolveRangeBounds(range, url.searchParams.get("start"), url.searchParams.get("end"), tz);
    where.push("timestamp >= ? AND timestamp < ?");
    binds.push(bounds.startIso, bounds.endIso);
  }
  if (model && model !== "__all__") {
    where.push("model = ?");
    binds.push(model);
  }
  if (source && source !== "__all__") {
    where.push("source = ?");
    binds.push(source);
  }
  if (result === "failed" || result === "1" || result === "true") {
    where.push("failed = 1");
  } else if (result === "success" || result === "0" || result === "false") {
    where.push("failed = 0");
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM usage_events ${whereSql}`)
    .bind(...binds)
    .first<{ c: number }>();
  const rows = (
    await env.DB.prepare(
      `SELECT * FROM usage_events ${whereSql}
       ORDER BY timestamp DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...binds, pageSize, offset)
      .all<any>()
  ).results ?? [];

  const total = totalRow?.c ?? 0;
  const prices = (await env.DB.prepare(`SELECT * FROM model_prices`).all<PriceRow>()).results ?? [];
  const priceMap = new Map(prices.map((p) => [p.model, p]));

  const events = rows.map((e) => {
    const agg = {
      input_tokens: e.input_tokens,
      output_tokens: e.output_tokens,
      reasoning_tokens: e.reasoning_tokens,
      cache_read_tokens: e.cache_read_tokens,
      cache_creation_tokens: e.cache_creation_tokens,
      total_tokens: e.total_tokens,
      request_count: 1,
      success_count: e.failed ? 0 : 1,
      failure_count: e.failed ? 1 : 0,
    };
    const cost = costFor(agg, priceMap.get(e.model));
    const speed =
      e.latency_ms > 0 && e.output_tokens > 0 ? (e.output_tokens / e.latency_ms) * 1000 : undefined;
    const rawKey = String(e.api_group_key || "unknown");
    const rawSource = String(e.source || e.auth_index || "");
    return {
      id: String(e.id),
      request_id: e.request_id,
      timestamp: e.timestamp,
      // Never expose raw API key to the browser (aligned with cpa-usage-keeper RedactSensitiveValue)
      api_key: redactSensitiveValue(rawKey),
      model: e.model,
      model_alias: e.model_alias || undefined,
      reasoning_effort: e.reasoning_effort || undefined,
      service_tier: e.service_tier || undefined,
      executor_type: e.executor_type || undefined,
      endpoint: e.endpoint || undefined,
      source: redactIfSensitiveLooking(rawSource),
      // Keep source_raw for filter value matching, but still mask if it looks like a key
      source_raw: redactIfSensitiveLooking(String(e.source || "")),
      auth_index: e.auth_index,
      failed: Boolean(e.failed),
      latency_ms: e.latency_ms,
      ttft_ms: e.ttft_ms ?? undefined,
      speed_tps: speed,
      tokens: {
        input_tokens: e.input_tokens,
        output_tokens: e.output_tokens,
        reasoning_tokens: e.reasoning_tokens,
        cache_read_tokens: e.cache_read_tokens,
        cache_creation_tokens: e.cache_creation_tokens,
        total_tokens: e.total_tokens,
      },
      cost_usd: cost ?? 0,
      cost_available: cost != null,
    };
  });

  return {
    events,
    total_count: total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function emptyAgg(): AggRow {
  return {
    request_count: 0,
    success_count: 0,
    failure_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
  };
}

function costFor(row: Partial<AggRow> & { input_tokens?: number; output_tokens?: number }, price?: PriceRow): number | null {
  if (!price) return null;
  const mult = price.price_multiplier || 1;
  const input = Number(row.input_tokens || 0);
  const output = Number(row.output_tokens || 0);
  const cacheRead = Number(row.cache_read_tokens || 0);
  const cacheWrite = Number(row.cache_creation_tokens || 0);
  const prompt = (input / 1_000_000) * price.prompt_price_per_1m;
  const completion = (output / 1_000_000) * price.completion_price_per_1m;
  const cr = (cacheRead / 1_000_000) * price.cache_read_price_per_1m;
  const cw = (cacheWrite / 1_000_000) * price.cache_write_price_per_1m;
  return (prompt + completion + cr + cw) * mult;
}
