# قرارداد صف‌ها (BullMQ)

تعریف در `src/infrastructure/queue/queues.ts` — پردازشگرها در `src/workers/index.ts`.

## صف‌ها

| صف | job | payload | فرکانس |
|----|-----|---------|--------|
| `backtest` | `run` | `{ backtestId }` | on-demand از API |
| `live-strategy` | `tick` | `{ liveStrategyId, action: "TICK" }` | هر N ثانیه (scheduler) |
| `live-strategy` | `start/pause/stop` | `{ liveStrategyId, action }` | on-demand |
| `notification` | `send` | `{ notificationId? , userId, type, payload }` | on-demand |
| `market-data` | `sync-pairs` | `{ type: "SYNC_PAIRS" }` | هر ۱۰ دقیقه |
| `reconciliation` | `reconcile` | `{}` | هر ۱ دقیقه |
| `subscription` | `sweep` | `{ type: "CHECK_EXPIRY" }` | هر ۵ دقیقه |
| `cleanup` | `cleanup-sessions` | `{ type: "EXPIRED_SESSIONS" }` | هر ۶ ساعت |
| `cleanup` | `cleanup-candles` | `{ type: "OLD_CANDLES" }` | روزانه |

## Job schedulers (کران)

BullMQ v6 — `queue.upsertJobScheduler(id, { every }, { name, data })`. در بوت ورکر ثبت می‌شوند؛ restart امن است.

## Tick لایو

هر `TICK_INTERVAL_SECONDS` (پیش‌فرض ۵s) برای هر LiveStrategy فعال یک job با `jobId` یکتا اضافه می‌شود — تکرار ممنوع.

## رفتار خطا

- BullMQ retry با backoff در تنظیمات job
- Circuit breaker سمت صرافی جلوی طوفان retry را می‌گیرد
- خطای reconciliation لاگ می‌شود ولی ورکر را نمی‌کشد
