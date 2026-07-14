import type { Env, PullResult, UsageEvent } from "../types";
import { CpaClient } from "../cpa/client";
import { sha256Hex } from "../lib/hash";
import { nowIso, parsePositiveInt, resolveTz, hourBucketStart, dayBucketStart } from "../lib/time";
import { decodeUsageMessage } from "./decode";

const META_LAST_SYNC = "last_synced_at";
const META_LAST_ERROR = "last_pull_error";
const META_PULL_LOCK = "pull_lock_until";

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, ts)
    .run();
}

export interface RunIngestOptions {
  /** Force pull even if within min interval (cron should set true). */
  force?: boolean;
  source?: string;
}

/**
 * Pull CPA usage queue → inbox → usage_events + hourly/daily aggregates.
 * Single-flight via app_meta pull_lock_until; throttle via last_synced_at + PULL_MIN_INTERVAL_SEC.
 */
export async function runIngest(env: Env, opts: RunIngestOptions = {}): Promise<PullResult> {
  const force = Boolean(opts.force);
  const source = opts.source ?? "http_pull";
  const minIntervalSec = parsePositiveInt(env.PULL_MIN_INTERVAL_SEC, 10);
  const batchSize = Math.min(parsePositiveInt(env.USAGE_QUEUE_BATCH_SIZE, 200), 1000);
  const maxRounds = Math.min(parsePositiveInt(env.USAGE_QUEUE_MAX_ROUNDS, 10), 50);
  const tz = resolveTz(env.TZ);

  const result: PullResult = {
    triggered: false,
    reason: "",
    rounds: 0,
    fetched: 0,
    insertedInbox: 0,
    processed: 0,
    insertedEvents: 0,
    dedupedEvents: 0,
    skippedControl: 0,
    failedDecode: 0,
    lastSyncedAt: await getMeta(env.DB, META_LAST_SYNC),
  };

  // Throttle for read-path pulls
  if (!force) {
    const last = result.lastSyncedAt;
    if (last) {
      const elapsed = Date.now() - new Date(last).getTime();
      if (Number.isFinite(elapsed) && elapsed < minIntervalSec * 1000) {
        result.reason = `throttled:${minIntervalSec}s`;
        return result;
      }
    }
  }

  // Single-flight lock (best-effort on D1)
  const now = Date.now();
  const lockUntil = await getMeta(env.DB, META_PULL_LOCK);
  if (lockUntil) {
    const untilMs = new Date(lockUntil).getTime();
    if (Number.isFinite(untilMs) && untilMs > now) {
      result.reason = "locked";
      return result;
    }
  }
  const lockExpiry = new Date(now + 55_000).toISOString();
  await setMeta(env.DB, META_PULL_LOCK, lockExpiry);

  result.triggered = true;
  result.reason = force ? "forced" : "interval";

  try {
    const client = CpaClient.fromEnv(env);

    for (let round = 0; round < maxRounds; round++) {
      const messages = await client.fetchUsageQueue(batchSize);
      result.rounds += 1;
      result.fetched += messages.length;

      if (messages.length === 0) break;

      const rawStrings: string[] = [];
      for (const item of messages) {
        if (item == null) continue;
        if (typeof item === "string") {
          rawStrings.push(item);
        } else {
          rawStrings.push(JSON.stringify(item));
        }
      }

      const inboxInserted = await insertInboxBatch(env.DB, rawStrings, source);
      result.insertedInbox += inboxInserted;

      const processed = await processPendingInbox(env.DB, tz, 500);
      result.processed += processed.processed;
      result.insertedEvents += processed.insertedEvents;
      result.dedupedEvents += processed.dedupedEvents;
      result.skippedControl += processed.skippedControl;
      result.failedDecode += processed.failedDecode;

      // Continue only if likely more data (full batch)
      if (messages.length < batchSize) break;
    }

    const syncedAt = nowIso();
    await setMeta(env.DB, META_LAST_SYNC, syncedAt);
    await setMeta(env.DB, META_LAST_ERROR, "");
    result.lastSyncedAt = syncedAt;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    result.lastError = msg;
    result.reason = "error";
    await setMeta(env.DB, META_LAST_ERROR, msg);
  } finally {
    // Release lock
    await setMeta(env.DB, META_PULL_LOCK, nowIso(new Date(0)));
  }

  return result;
}

async function insertInboxBatch(db: D1Database, messages: string[], source: string): Promise<number> {
  if (messages.length === 0) return 0;
  const ts = nowIso();
  let inserted = 0;

  // D1 batch — dedupe by message_hash
  const stmts: D1PreparedStatement[] = [];
  for (const raw of messages) {
    if (!raw || raw === "null") continue;
    const hash = await sha256Hex(raw);
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO usage_inbox
            (message_hash, raw_message, source, status, attempt_count, popped_at, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .bind(hash, raw, source, ts, ts, ts),
    );
  }
  if (stmts.length === 0) return 0;

  // Chunk to avoid oversized batches
  for (let i = 0; i < stmts.length; i += 50) {
    const chunk = stmts.slice(i, i + 50);
    const res = await db.batch(chunk);
    for (const r of res) {
      inserted += r.meta.changes ?? 0;
    }
  }
  return inserted;
}

interface ProcessStats {
  processed: number;
  insertedEvents: number;
  dedupedEvents: number;
  skippedControl: number;
  failedDecode: number;
}

export async function processPendingInbox(db: D1Database, timeZone: string, limit = 200): Promise<ProcessStats> {
  const stats: ProcessStats = {
    processed: 0,
    insertedEvents: 0,
    dedupedEvents: 0,
    skippedControl: 0,
    failedDecode: 0,
  };

  const rows = await db
    .prepare(
      `SELECT id, raw_message FROM usage_inbox
       WHERE status = 'pending'
       ORDER BY id ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: number; raw_message: string }>();

  const list = rows.results ?? [];
  if (list.length === 0) return stats;

  const fetchedAt = new Date();

  for (const row of list) {
    stats.processed += 1;
    const decoded = decodeUsageMessage(row.raw_message, fetchedAt);
    const ts = nowIso();

    if (decoded.kind === "control") {
      stats.skippedControl += 1;
      await db
        .prepare(
          `UPDATE usage_inbox SET status = 'skipped', processed_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`,
        )
        .bind(ts, ts, row.id)
        .run();
      continue;
    }

    if (decoded.kind === "invalid") {
      stats.failedDecode += 1;
      await db
        .prepare(
          `UPDATE usage_inbox
           SET status = 'failed', attempt_count = attempt_count + 1, last_error = ?, processed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(decoded.error.slice(0, 500), ts, ts, row.id)
        .run();
      continue;
    }

    const event = decoded.event;
    const insertResult = await insertEventAndAggregate(db, event, timeZone, ts);
    if (insertResult === "inserted") stats.insertedEvents += 1;
    else stats.dedupedEvents += 1;

    await db
      .prepare(
        `UPDATE usage_inbox
         SET status = 'processed', event_key = ?, processed_at = ?, updated_at = ?, last_error = NULL
         WHERE id = ?`,
      )
      .bind(event.eventKey, ts, ts, row.id)
      .run();
  }

  return stats;
}

async function insertEventAndAggregate(
  db: D1Database,
  event: UsageEvent,
  timeZone: string,
  now: string,
): Promise<"inserted" | "deduped"> {
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO usage_events (
        event_key, api_group_key, provider, endpoint, auth_type, request_id, model, model_alias,
        reasoning_effort, service_tier, executor_type, timestamp, source, auth_index, failed,
        latency_ms, ttft_ms, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
        cache_read_tokens, cache_creation_tokens, total_tokens, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.eventKey,
      event.apiGroupKey,
      event.provider,
      event.endpoint,
      event.authType,
      event.requestId,
      event.model,
      event.modelAlias,
      event.reasoningEffort,
      event.serviceTier,
      event.executorType,
      event.timestamp,
      event.source,
      event.authIndex,
      event.failed ? 1 : 0,
      event.latencyMs,
      event.ttftMs,
      event.inputTokens,
      event.outputTokens,
      event.reasoningTokens,
      event.cachedTokens,
      event.cacheReadTokens,
      event.cacheCreationTokens,
      event.totalTokens,
      now,
    )
    .run();

  const changes = insert.meta.changes ?? 0;
  if (changes === 0) return "deduped";

  const hour = hourBucketStart(event.timestamp, timeZone);
  const day = dayBucketStart(event.timestamp, timeZone);
  const success = event.failed ? 0 : 1;
  const failure = event.failed ? 1 : 0;

  await upsertAggregate(db, "usage_hourly_stats", hour, event, success, failure, now);
  await upsertAggregate(db, "usage_daily_stats", day, event, success, failure, now);
  return "inserted";
}

async function upsertAggregate(
  db: D1Database,
  table: "usage_hourly_stats" | "usage_daily_stats",
  bucketStart: string,
  event: UsageEvent,
  success: number,
  failure: number,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ${table} (
        bucket_start, api_group_key, model, auth_index, model_alias,
        request_count, success_count, failure_count,
        input_tokens, output_tokens, reasoning_tokens, cached_tokens,
        cache_read_tokens, cache_creation_tokens, total_tokens,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bucket_start, api_group_key, model, auth_index, model_alias) DO UPDATE SET
        request_count = request_count + 1,
        success_count = success_count + excluded.success_count,
        failure_count = failure_count + excluded.failure_count,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
        cached_tokens = cached_tokens + excluded.cached_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
        total_tokens = total_tokens + excluded.total_tokens,
        updated_at = excluded.updated_at`,
    )
    .bind(
      bucketStart,
      event.apiGroupKey,
      event.model,
      event.authIndex,
      event.modelAlias,
      success,
      failure,
      event.inputTokens,
      event.outputTokens,
      event.reasoningTokens,
      event.cachedTokens,
      event.cacheReadTokens,
      event.cacheCreationTokens,
      event.totalTokens,
      now,
      now,
    )
    .run();
}
