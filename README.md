# CPA Statistics (Cloudflare Workers)

用 **Cloudflare Workers + D1** 实现 [cpa-usage-keeper](https://github.com/Willxup/cpa-usage-keeper) 的**核心统计**：

- 通过 CPA 公网 Management API **HTTP 拉** `usage-queue`（无需自建 Redis）
- 事件落 D1，并维护 **小时 / 日预聚合**
- **Cron 每分钟**保底同步；**打开看板时**读路径触发拉取（默认 ≥10s 节流，体感准实时）
- 简易 Dashboard（自动刷新）

> 这是 MVP：不含完整 React 看板、Quota 巡检、identity 元数据同步、复杂 Analysis。字段语义对齐原项目 usage 事件。

## 架构

```
CPA (公网, usage-statistics-enabled)
  GET /v0/management/usage-queue?count=N
        ▲
        │ Bearer CPA_MANAGEMENT_KEY
        │
Workers ── Cron * * * * * ──► runIngest(force)
       └── GET /api/overview?sync=1 ──► runIngest(节流)
                │
                ▼
              D1: usage_inbox → usage_events
                  usage_hourly_stats / usage_daily_stats
                │
                ▼
           / public dashboard
```

## 快速开始

### 1. 安装依赖

```bash
npm install
npm --prefix web install
npm run build:web   # 构建原版精简前端 → web/dist
```

### 2. 本地密钥

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars：
# CPA_BASE_URL=https://your-cpa.example.com:8317
# CPA_MANAGEMENT_KEY=...
# DASHBOARD_PASSWORD=...   # 可选，启用后走原版登录页
```

### 3. 初始化本地 D1 表

```bash
npm run db:local
```

### 4. 本地开发

```bash
npm run dev
# 默认 http://0.0.0.0:9000
```

打开看板：使用**原 cpa-usage-keeper 前端**（已去掉 Auth Files / AI Provider 页）。  
Overview 打开时会节流拉取 CPA；Cron 每分钟保底同步。

### 5. 部署到 Cloudflare（推荐：GitHub Actions）

本机网络受限时，用仓库自带的 Actions 直接从 GitHub 跑 `wrangler deploy`（不走任何本机代理）。

1. 把代码推到 GitHub（`main` / `master`）
2. 在仓库 **Settings → Secrets and variables → Actions** 添加 Secrets：

| Secret | 说明 |
|--------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（Workers 编辑 + D1 编辑 + Account 读） |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID（已在 `wrangler.toml` 的 `account_id`） |
| `CPA_BASE_URL` | CPA 管理端地址，如 `https://your-cpa:8317` |
| `CPA_MANAGEMENT_KEY` | CPA Management Key |
| `DASHBOARD_PASSWORD` | 看板登录密码（建议设置） |

3. 推送 `main` 自动部署，或手动 **Actions → Deploy → Run workflow**
4. 部署完成后 URL 形如：`https://cpa-statistics.<subdomain>.workers.dev`

首次部署前请确认 `wrangler.toml` 里的 `database_id` 已指向你的 D1；workflow 会执行 `schema.sql` 并同步 secrets。

#### 本机手动部署（网络正常时）

```bash
npx wrangler login
npx wrangler d1 create cpa-statistics
# 把 database_id 写入 wrangler.toml

npm run db:remote
npx wrangler secret put CPA_BASE_URL
npx wrangler secret put CPA_MANAGEMENT_KEY
npx wrangler secret put DASHBOARD_PASSWORD   # 可选

npm run deploy   # 会先 build:web 再 deploy
```

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 同步状态与计数 |
| GET | `/api/cpa/ping` | 探测 CPA usage-queue 是否可达 |
| GET/POST | `/api/ingest?force=1` | 手动强制拉取并处理 |
| GET | `/api/overview?range=today\|24h\|7d\|30d&sync=1` | 汇总 + 序列；`sync=1` 时读路径拉取 |
| GET | `/api/events?page=1&pageSize=20&model=&failed=&q=` | 事件列表 |

若设置了 `DASHBOARD_PASSWORD`，请求需带：

```http
Authorization: Bearer <password>
```

## 配置

| 名称 | 位置 | 说明 |
|------|------|------|
| `CPA_BASE_URL` | secret / `.dev.vars` | CPA 根地址，如 `https://host:8317` |
| `CPA_MANAGEMENT_KEY` | secret | Management Bearer Token |
| `DASHBOARD_PASSWORD` | secret（可选） | 看板/API 简易鉴权 |
| `TZ` | `wrangler.toml` vars | 业务时区，默认 `Asia/Shanghai` |
| `PULL_MIN_INTERVAL_SEC` | vars | 读路径最小拉取间隔，默认 `10` |
| `USAGE_QUEUE_BATCH_SIZE` | vars | 单次队列拉取条数，默认 `200` |
| `USAGE_QUEUE_MAX_ROUNDS` | vars | 单轮最多连续满批次数，默认 `10` |

## CPA 侧要求

1. `usage-statistics-enabled: true`
2. Management Key 有效，且 **公网可访问** `/v0/management/usage-queue`
3. 注意：usage-queue 为**消费式读取**（拉走即离开队列）。本服务先写入 `usage_inbox` 再解析，降低丢数风险；仍建议只跑**一个**消费者（不要同时跑原 Keeper 抢同一队列，除非你清楚后果）

## 价格（可选）

在 D1 中插入 `model_prices` 后，overview 模型成本才有估算：

```sql
INSERT INTO model_prices (
  model, pricing_style,
  prompt_price_per_1m, completion_price_per_1m,
  cache_read_price_per_1m, cache_write_price_per_1m,
  price_multiplier, updated_at
) VALUES (
  'gpt-4o-mini', 'openai',
  0.15, 0.60, 0.075, 0,
  1, datetime('now')
);
```

## 前端说明

| 保留 | 已去掉 |
|------|--------|
| Overview（统计卡片 / 图表 / 健康度） | Auth Files 凭证页 |
| Analysis（组成/效率，部分图表可能简化） | AI Provider 凭证页 |
| Request Events | Quota 巡检 / 重置 |
| Settings（价格；API Key 设置列表为空 stub） | Request log 从 CPA 拉全文 |
| 原版登录页（cookie session） | CPAMC 嵌入深度能力 |

前端源码在 `web/`（源自 [cpa-usage-keeper](https://github.com/Willxup/cpa-usage-keeper)），Worker 提供 `/api/v1/*` 兼容层。

## 目录

```
schema.sql
src/index.ts              Worker 入口 + /api/v1 路由
src/cpa/client.ts         CPA HTTP usage-queue
src/ingest/               解码 + 拉取 + 预聚合
src/api/compat/           原版 API 响应形状
web/                      原版 React 前端（已精简 tab）
web/dist/                 构建产物（Workers Assets）
public/index.html         旧简易页（备用）
```

## 后续可做

- [ ] 同步 CPA auth-files / api-keys → 身份显示名
- [ ] Overview realtime 面板补齐时序点（现多为空结构 + 模型 Top）
- [ ] Analysis heatmap / latency 诊断
- [ ] R2 归档超期明细
- [ ] CF Access 替代简易密码

## 许可

MIT（对齐上游生态；本仓库为独立实现）
