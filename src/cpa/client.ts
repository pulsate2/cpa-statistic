import type { Env } from "../types";

export class CpaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly managementKey: string,
  ) {}

  static fromEnv(env: Env): CpaClient {
    const base = (env.CPA_BASE_URL || "").trim().replace(/\/+$/, "");
    const key = (env.CPA_MANAGEMENT_KEY || "").trim();
    if (!base) throw new Error("CPA_BASE_URL is required");
    if (!key) throw new Error("CPA_MANAGEMENT_KEY is required");
    return new CpaClient(base, key);
  }

  /** GET /v0/management/usage-queue?count=N — destructive read of usage events. */
  async fetchUsageQueue(count: number): Promise<unknown[]> {
    const url = `${this.baseUrl}/v0/management/usage-queue?count=${encodeURIComponent(String(count))}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.managementKey}`,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`usage-queue HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text.trim()) return [];
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed;
    // Some CPA builds may wrap payload
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.payload)) return obj.payload;
      if (Array.isArray(obj.data)) return obj.data;
      if (Array.isArray(obj.items)) return obj.items;
    }
    throw new Error("usage-queue response is not an array");
  }

  async ping(): Promise<{ ok: boolean; status: number; detail?: string }> {
    try {
      // Lightweight probe: empty/small queue pull
      const url = `${this.baseUrl}/v0/management/usage-queue?count=1`;
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.managementKey}`,
          Accept: "application/json",
        },
      });
      const detail = res.ok ? undefined : (await res.text()).slice(0, 200);
      return { ok: res.ok, status: res.status, detail };
    } catch (e) {
      return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
    }
  }
}
