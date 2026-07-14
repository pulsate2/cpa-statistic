export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  CPA_BASE_URL: string;
  CPA_MANAGEMENT_KEY: string;
  DASHBOARD_PASSWORD?: string;
  TZ?: string;
  PULL_MIN_INTERVAL_SEC?: string;
  USAGE_QUEUE_BATCH_SIZE?: string;
  USAGE_QUEUE_MAX_ROUNDS?: string;
}

export type InboxStatus = "pending" | "processed" | "failed" | "skipped";

export interface UsageEvent {
  eventKey: string;
  apiGroupKey: string;
  provider: string;
  endpoint: string;
  authType: string;
  requestId: string;
  model: string;
  modelAlias: string;
  reasoningEffort: string;
  serviceTier: string;
  executorType: string;
  timestamp: string; // ISO UTC storage
  source: string;
  authIndex: string;
  failed: boolean;
  latencyMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
}

export interface PullResult {
  triggered: boolean;
  reason: string;
  rounds: number;
  fetched: number;
  insertedInbox: number;
  processed: number;
  insertedEvents: number;
  dedupedEvents: number;
  skippedControl: number;
  failedDecode: number;
  lastError?: string;
  lastSyncedAt: string | null;
}

export interface OverviewSummary {
  requestCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface SeriesPoint {
  bucket: string;
  requests: number;
  tokens: number;
  success: number;
  failure: number;
  costUsd: number | null;
}

export interface ModelBreakdown {
  model: string;
  requests: number;
  tokens: number;
  costUsd: number | null;
}
