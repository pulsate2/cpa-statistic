import type { Env } from "./types";
import { runIngest, getMeta } from "./ingest/pipeline";
import { getHealth } from "./api/queries";
import { CpaClient } from "./cpa/client";
import {
  authDisabled,
  clearSessionCookie,
  createSessionCookie,
  isAuthenticated,
  sessionJson,
} from "./api/compat/auth";
import {
  buildAnalysisV1,
  buildEventsV1,
  buildEventSourceFiltersV1,
  buildUsageOverviewV1,
  emptyRealtime,
} from "./api/compat/usage";
import { resolveTz } from "./lib/time";
import { nowIso } from "./lib/time";
import { getEmbeddedAsset } from "./embedded-assets";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return json({ error: message }, 500);
      }
    }

    // Prefer CF Assets when bound; otherwise serve build-time embedded SPA.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    const embedded = getEmbeddedAsset(url.pathname === "/" ? "/index.html" : url.pathname);
    if (embedded) {
      const body =
        embedded.encoding === "base64"
          ? Uint8Array.from(atob(embedded.body), (c) => c.charCodeAt(0))
          : embedded.body;
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": embedded.contentType,
          "cache-control": url.pathname.startsWith("/assets/")
            ? "public, max-age=31536000, immutable"
            : "no-cache",
        },
      });
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runIngest(env, { force: true, source: "cron" }).then((r) => {
        console.log("cron ingest", JSON.stringify(r));
      }),
    );
  },
};

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  // --- Legacy simple APIs (still useful for debugging) ---
  if (url.pathname === "/api/health" && request.method === "GET") {
    if (!(await isAuthenticated(request, env.DASHBOARD_PASSWORD))) return unauthorized();
    return json(await getHealth(env));
  }
  if (url.pathname === "/api/cpa/ping" && request.method === "GET") {
    if (!(await isAuthenticated(request, env.DASHBOARD_PASSWORD))) return unauthorized();
    const ping = await CpaClient.fromEnv(env).ping();
    return json(ping, ping.ok ? 200 : 502);
  }
  if (url.pathname === "/api/ingest" && (request.method === "GET" || request.method === "POST")) {
    if (!(await isAuthenticated(request, env.DASHBOARD_PASSWORD))) return unauthorized();
    const force = url.searchParams.get("force") === "1";
    return json(await runIngest(env, { force, source: force ? "manual" : "api" }));
  }

  // --- Original frontend: /api/v1/* ---
  if (url.pathname.startsWith("/api/v1")) {
    return handleV1(request, env, ctx, url);
  }

  return json({ error: "not found" }, 404);
}

async function handleV1(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  const secure = url.protocol === "https:";

  // Auth routes (no prior session required for login/session probe)
  if (path === "/api/v1/auth/session" && method === "GET") {
    const ok = await isAuthenticated(request, env.DASHBOARD_PASSWORD);
    return json(sessionJson(ok));
  }

  if (path === "/api/v1/auth/login" && method === "POST") {
    if (authDisabled(env.DASHBOARD_PASSWORD)) {
      return json(sessionJson(true));
    }
    let body: { password?: string } = {};
    try {
      body = (await request.json()) as { password?: string };
    } catch {
      /* empty */
    }
    if ((body.password || "").trim() !== env.DASHBOARD_PASSWORD!.trim()) {
      return json({ error: "invalid password" }, 401);
    }
    const cookie = await createSessionCookie(env.DASHBOARD_PASSWORD!, secure);
    return json(sessionJson(true), 200, { "Set-Cookie": cookie });
  }

  if (path === "/api/v1/auth/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(secure) });
  }

  if (path === "/api/v1/auth/api-key-login" && method === "POST") {
    return json({ error: "api key login not supported in workers mvp" }, 400);
  }

  // Everything else requires auth
  if (!(await isAuthenticated(request, env.DASHBOARD_PASSWORD))) {
    return unauthorized();
  }

  // Soft pull on read paths for near-realtime
  const maybePull = () => {
    ctx.waitUntil(runIngest(env, { force: false, source: "read_path" }).then(() => undefined));
  };

  if (path === "/api/v1/status" && method === "GET") {
    maybePull();
    const last = await getMeta(env.DB, "last_synced_at");
    const err = await getMeta(env.DB, "last_pull_error");
    return json({
      running: true,
      sync_running: false,
      timezone: resolveTz(env.TZ),
      cpa_public_url: (env.CPA_BASE_URL || "").replace(/\/+$/, ""),
      cpa_request_log_access_enabled: false,
      last_run_at: last || undefined,
      last_error: err || undefined,
      last_status: last ? "completed" : "idle",
    });
  }

  if (path === "/api/v1/version" && method === "GET") {
    return json({ version: "0.1.0-workers", updateCheckEnabled: false });
  }

  if (path === "/api/v1/usage/overview" && method === "GET") {
    // sync=force → 强制拉 CPA；sync=0 → 只读 D1；其它/缺省 → 节流拉
    const sync = (url.searchParams.get("sync") || "").toLowerCase();
    if (sync === "force") {
      await runIngest(env, { force: true, source: "manual_refresh" });
    } else if (sync === "0" || sync === "false" || sync === "no") {
      // read-only from D1
    } else {
      await runIngest(env, { force: false, source: "read_path" });
    }
    return json(await buildUsageOverviewV1(env, url));
  }

  if (path === "/api/v1/usage/sync" && method === "POST") {
    const result = await runIngest(env, { force: true, source: "manual_refresh" });
    return json({ ok: !result.lastError, ...result });
  }

  if (path === "/api/v1/usage/overview/realtime" && method === "GET") {
    maybePull();
    const window = url.searchParams.get("window") || "15m";
    const block = emptyRealtime(window);
    block.timezone = resolveTz(env.TZ);
    // Fill current_usage models from recent hourly
    try {
      const rows = (
        await env.DB.prepare(
          `SELECT model, SUM(request_count) AS requests, SUM(total_tokens) AS tokens
           FROM usage_hourly_stats
           GROUP BY model
           ORDER BY tokens DESC
           LIMIT 10`,
        ).all<{ model: string; requests: number; tokens: number }>()
      ).results ?? [];
      const total = rows.reduce((s, r) => s + Number(r.tokens || 0), 0) || 1;
      const usage = block.current_usage as { models: Array<Record<string, unknown>> };
      usage.models = rows.map((r) => ({
        key: r.model,
        label: r.model,
        tokens: r.tokens,
        requests: r.requests,
        share: Number(r.tokens || 0) / total,
      }));
    } catch {
      /* ignore */
    }
    return json(block);
  }

  if (path === "/api/v1/usage/analysis" && method === "GET") {
    maybePull();
    return json(await buildAnalysisV1(env, url));
  }

  if (path === "/api/v1/usage/events" && method === "GET") {
    maybePull();
    return json(await buildEventsV1(env, url));
  }

  if (path === "/api/v1/usage/events/filters/models" && method === "GET") {
    const rows = (
      await env.DB.prepare(`SELECT DISTINCT model FROM usage_events ORDER BY model ASC LIMIT 500`).all<{ model: string }>()
    ).results ?? [];
    return json({ models: rows.map((r) => r.model) });
  }

  if (path === "/api/v1/usage/events/filters/sources" && method === "GET") {
    return json(await buildEventSourceFiltersV1(env));
  }

  if (path.startsWith("/api/v1/usage/events/") && path.endsWith("/request-log") && method === "GET") {
    return json({
      event_id: path.split("/")[5] || "",
      available: false,
      previewable: false,
      downloadable: false,
      sections: [],
    });
  }

  if (path === "/api/v1/usage/events/export" && method === "GET") {
    const data = await buildEventsV1(env, url);
    return json(data);
  }

  // Pricing
  if (path === "/api/v1/pricing" && method === "GET") {
    const rows = (await env.DB.prepare(`SELECT * FROM model_prices ORDER BY model`).all<any>()).results ?? [];
    return json({
      pricing: rows.map((r) => ({
        model: r.model,
        pricing_style: r.pricing_style,
        prompt_price_per_1m: r.prompt_price_per_1m,
        completion_price_per_1m: r.completion_price_per_1m,
        cache_read_price_per_1m: r.cache_read_price_per_1m,
        cache_write_price_per_1m: r.cache_write_price_per_1m,
        price_multiplier: r.price_multiplier,
      })),
    });
  }

  if (path === "/api/v1/pricing" && method === "PUT") {
    const body = (await request.json()) as any;
    const model = String(body.model || "").trim();
    if (!model) return json({ error: "model required" }, 400);
    const ts = nowIso();
    await env.DB.prepare(
      `INSERT INTO model_prices (
        model, pricing_style, prompt_price_per_1m, completion_price_per_1m,
        cache_read_price_per_1m, cache_write_price_per_1m, price_multiplier, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET
        pricing_style = excluded.pricing_style,
        prompt_price_per_1m = excluded.prompt_price_per_1m,
        completion_price_per_1m = excluded.completion_price_per_1m,
        cache_read_price_per_1m = excluded.cache_read_price_per_1m,
        cache_write_price_per_1m = excluded.cache_write_price_per_1m,
        price_multiplier = excluded.price_multiplier,
        updated_at = excluded.updated_at`,
    )
      .bind(
        model,
        body.pricing_style || "openai",
        Number(body.prompt_price_per_1m) || 0,
        Number(body.completion_price_per_1m) || 0,
        Number(body.cache_read_price_per_1m) || 0,
        Number(body.cache_write_price_per_1m) || 0,
        body.price_multiplier == null ? 1 : Number(body.price_multiplier),
        ts,
      )
      .run();
    return json({
      model,
      pricing_style: body.pricing_style || "openai",
      prompt_price_per_1m: Number(body.prompt_price_per_1m) || 0,
      completion_price_per_1m: Number(body.completion_price_per_1m) || 0,
      cache_read_price_per_1m: Number(body.cache_read_price_per_1m) || 0,
      cache_write_price_per_1m: Number(body.cache_write_price_per_1m) || 0,
      price_multiplier: body.price_multiplier == null ? 1 : Number(body.price_multiplier),
    });
  }

  if (path === "/api/v1/pricing" && method === "DELETE") {
    const model = url.searchParams.get("model") || "";
    if (model) {
      await env.DB.prepare(`DELETE FROM model_prices WHERE model = ?`).bind(model).run();
    }
    return json({ ok: true });
  }

  if (path === "/api/v1/pricing/sync/preview" && method === "GET") {
    return json({ source: "none", matches: [], unmatchedModels: [] });
  }

  if (path === "/api/v1/models/used" && method === "GET") {
    const rows = (
      await env.DB.prepare(`SELECT DISTINCT model FROM usage_events ORDER BY model ASC`).all<{ model: string }>()
    ).results ?? [];
    return json({ models: rows.map((r) => r.model) });
  }

  // Stubs for removed features so UI does not hard-crash
  if (path === "/api/v1/usage/api-keys/options" && method === "GET") {
    return json({ items: [] });
  }
  if (path === "/api/v1/usage/api-keys" && method === "GET") {
    return json({ items: [] });
  }
  if (path === "/api/v1/usage/api-keys/settings" && method === "GET") {
    return json({ items: [] });
  }
  if (path === "/api/v1/auth/sessions" && method === "GET") {
    return json({ items: [] });
  }
  if (path === "/api/v1/usage/identities" && method === "GET") {
    return json({ items: [] });
  }
  if (path === "/api/v1/usage/identities/page" && method === "GET") {
    return json({ items: [], total_count: 0, page: 1, page_size: 20, total_pages: 1 });
  }
  if (path.startsWith("/api/v1/quota/")) {
    return json({ items: [], tasks: [], status: "idle" });
  }
  if (path === "/api/v1/update/check" && method === "GET") {
    return json({
      currentVersion: "0.1.0-workers",
      latestVersion: "0.1.0-workers",
      updateAvailable: false,
      canCompare: false,
      message: "update check disabled",
    });
  }

  return json({ error: `not found: ${path}` }, 404);
}

function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401);
}

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(JSON.stringify(data), { status, headers });
}
