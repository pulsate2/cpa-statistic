import type { Env, ModelBreakdown, OverviewSummary, SeriesPoint } from "../types";
import { rangeStartForPreset, resolveTz } from "../lib/time";
import { getMeta } from "../ingest/pipeline";

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

interface ModelRow extends AggRow {
  model: string;
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

export async function getOverview(env: Env, range = "today") {
  const tz = resolveTz(env.TZ);
  const { startBucket, endBucket, granularity } = rangeStartForPreset(range, tz);
  const table = granularity === "hour" ? "usage_hourly_stats" : "usage_daily_stats";

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
    .bind(startBucket, endBucket)
    .first<AggRow>();

  const seriesRows = await env.DB.prepare(
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
    .bind(startBucket, endBucket)
    .all<SeriesRow>();

  const modelRows = await env.DB.prepare(
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
     GROUP BY model
     ORDER BY total_tokens DESC
     LIMIT 20`,
  )
    .bind(startBucket, endBucket)
    .all<ModelRow>();

  const prices = await env.DB.prepare(`SELECT * FROM model_prices`).all<PriceRow>();
  const priceMap = new Map((prices.results ?? []).map((p) => [p.model, p]));

  const summary = toSummary(summaryRow, priceMap, modelRows.results ?? []);
  const series: SeriesPoint[] = (seriesRows.results ?? []).map((r) => ({
    bucket: r.bucket_start,
    requests: r.request_count,
    tokens: r.total_tokens,
    success: r.success_count,
    failure: r.failure_count,
    costUsd: estimateCostForAgg(r, priceMap),
  }));

  const models: ModelBreakdown[] = (modelRows.results ?? []).map((r) => ({
    model: r.model,
    requests: r.request_count,
    tokens: r.total_tokens,
    costUsd: estimateCostForModel(r, priceMap.get(r.model)),
  }));

  return {
    range,
    timezone: tz,
    granularity,
    startBucket,
    endBucket,
    lastSyncedAt: await getMeta(env.DB, "last_synced_at"),
    lastPullError: await getMeta(env.DB, "last_pull_error"),
    summary,
    series,
    models,
  };
}

function toSummary(
  row: AggRow | null,
  priceMap: Map<string, PriceRow>,
  modelRows: ModelRow[],
): OverviewSummary {
  const r = row ?? {
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
  const req = r.request_count;
  const successRate = req > 0 ? r.success_count / req : 1;

  // Prefer per-model cost sum when models present
  let cost: number | null = null;
  if (modelRows.length > 0 && priceMap.size > 0) {
    let sum = 0;
    let any = false;
    for (const m of modelRows) {
      const c = estimateCostForModel(m, priceMap.get(m.model));
      if (c != null) {
        sum += c;
        any = true;
      }
    }
    cost = any ? sum : null;
  }

  return {
    requestCount: r.request_count,
    successCount: r.success_count,
    failureCount: r.failure_count,
    successRate,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    totalTokens: r.total_tokens,
    estimatedCostUsd: cost,
  };
}

function estimateCostForAgg(row: AggRow, priceMap: Map<string, PriceRow>): number | null {
  // Without model split, cannot price accurately
  if (priceMap.size === 0) return null;
  return null;
}

function estimateCostForModel(row: AggRow & { model?: string }, price?: PriceRow): number | null {
  if (!price) return null;
  const mult = price.price_multiplier || 1;
  if (price.pricing_style === "claude") {
    // Claude-style: prompt + completion + cache read/write
    const prompt = (row.input_tokens / 1_000_000) * price.prompt_price_per_1m;
    const completion = (row.output_tokens / 1_000_000) * price.completion_price_per_1m;
    const cacheRead = (row.cache_read_tokens / 1_000_000) * price.cache_read_price_per_1m;
    const cacheWrite = (row.cache_creation_tokens / 1_000_000) * price.cache_write_price_per_1m;
    return (prompt + completion + cacheRead + cacheWrite) * mult;
  }
  // openai-style: prompt + completion; cache read optional
  const prompt = (row.input_tokens / 1_000_000) * price.prompt_price_per_1m;
  const completion = (row.output_tokens / 1_000_000) * price.completion_price_per_1m;
  const cacheRead = (row.cache_read_tokens / 1_000_000) * price.cache_read_price_per_1m;
  return (prompt + completion + cacheRead) * mult;
}

export async function listEvents(
  env: Env,
  opts: {
    page?: number;
    pageSize?: number;
    model?: string;
    authIndex?: string;
    failed?: string;
    q?: string;
  },
) {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const binds: unknown[] = [];

  if (opts.model) {
    where.push("model = ?");
    binds.push(opts.model);
  }
  if (opts.authIndex) {
    where.push("auth_index = ?");
    binds.push(opts.authIndex);
  }
  if (opts.failed === "1" || opts.failed === "true") {
    where.push("failed = 1");
  } else if (opts.failed === "0" || opts.failed === "false") {
    where.push("failed = 0");
  }
  if (opts.q) {
    where.push("(request_id LIKE ? OR event_key LIKE ? OR source LIKE ?)");
    const like = `%${opts.q}%`;
    binds.push(like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS c FROM usage_events ${whereSql}`)
    .bind(...binds)
    .first<{ c: number }>();

  const rows = await env.DB.prepare(
    `SELECT * FROM usage_events ${whereSql}
     ORDER BY timestamp DESC, id DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, offset)
    .all();

  const total = totalRow?.c ?? 0;
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    events: rows.results ?? [],
  };
}

export async function getHealth(env: Env) {
  const [lastSyncedAt, lastPullError, eventCount, pendingInbox, failedInbox] = await Promise.all([
    getMeta(env.DB, "last_synced_at"),
    getMeta(env.DB, "last_pull_error"),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM usage_events`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM usage_inbox WHERE status = 'pending'`).first<{ c: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS c FROM usage_inbox WHERE status = 'failed'`).first<{ c: number }>(),
  ]);

  return {
    ok: true,
    timezone: resolveTz(env.TZ),
    cpaBaseUrlConfigured: Boolean((env.CPA_BASE_URL || "").trim()),
    lastSyncedAt,
    lastPullError: lastPullError || null,
    counts: {
      usageEvents: eventCount?.c ?? 0,
      pendingInbox: pendingInbox?.c ?? 0,
      failedInbox: failedInbox?.c ?? 0,
    },
  };
}
