-- CPA Statistics (Cloudflare D1) — core stats MVP

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_hash TEXT NOT NULL UNIQUE,
  raw_message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'http_pull',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processed | failed | skipped
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  event_key TEXT,
  popped_at TEXT NOT NULL,
  processed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_inbox_status_id
  ON usage_inbox (status, id);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  api_group_key TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  endpoint TEXT NOT NULL DEFAULT '',
  auth_type TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  model_alias TEXT NOT NULL DEFAULT '',
  reasoning_effort TEXT NOT NULL DEFAULT '',
  service_tier TEXT NOT NULL DEFAULT '',
  executor_type TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  auth_index TEXT NOT NULL DEFAULT '',
  failed INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_events_timestamp
  ON usage_events (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_model_ts
  ON usage_events (model, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_auth_ts
  ON usage_events (auth_index, timestamp DESC);

CREATE TABLE IF NOT EXISTS usage_hourly_stats (
  bucket_start TEXT NOT NULL,
  api_group_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  auth_index TEXT NOT NULL DEFAULT '',
  model_alias TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_start, api_group_key, model, auth_index, model_alias)
);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_bucket
  ON usage_hourly_stats (bucket_start);

CREATE TABLE IF NOT EXISTS usage_daily_stats (
  bucket_start TEXT NOT NULL,
  api_group_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'unknown',
  auth_index TEXT NOT NULL DEFAULT '',
  model_alias TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_start, api_group_key, model, auth_index, model_alias)
);

CREATE INDEX IF NOT EXISTS idx_usage_daily_bucket
  ON usage_daily_stats (bucket_start);

CREATE TABLE IF NOT EXISTS model_prices (
  model TEXT PRIMARY KEY NOT NULL,
  pricing_style TEXT NOT NULL DEFAULT 'openai', -- openai | claude
  prompt_price_per_1m REAL NOT NULL DEFAULT 0,
  completion_price_per_1m REAL NOT NULL DEFAULT 0,
  cache_read_price_per_1m REAL NOT NULL DEFAULT 0,
  cache_write_price_per_1m REAL NOT NULL DEFAULT 0,
  price_multiplier REAL NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
