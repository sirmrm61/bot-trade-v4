# نقشه بازیابی (Recovery)

## بوت ورکر

۱. اتصال به Redis و Prisma
۲. لود همه `LiveStrategy` با status `ACTIVE`/`PAUSED`
۳. برای هر کدام: واکشی سفارش‌های باز از صرافی + مقایسه با DB داخلی
۴. ترمیم اختلاف:
   - سفارشی که در صرافی نیست ولی در DB باز است → `CANCELLED`/`FILLED` بر اساس state واقعی
   - سفارشی که در صرافی باز است ولی DB نمی‌داند → ثبت/نادیده‌گیری با لاگ
   - پوزیشن باز بدون SL/TP → ثبت مجدد دستورات حفاظتی
۵. ثبت job scheduler ها و شروع tick loop

## سناریوهای خرابی

| سناریو | رفتار |
|--------|-------|
| قطع Redis | BullMQ صبر می‌کند؛ retryStrategy اتصال مجدد |
| قطع صرافی | Circuit breaker → PAUSED روی آن سفارش؛ در reconnect ادامه |
| crash ورکر وسط معامله | سفارش orphan در صرافی می‌ماند → reconciliation در بوت بعدی آن را می‌گیرد |
| DB و صرافی ناهماهنگ | reconciliation هر دقیقه + در بوت |

## بررسی سلامت

```
GET /api/health/db     → prisma ping
GET /api/health/redis  → redis ping
GET /api/health/worker → آخرین heartbeat
GET /api/health/exchange → اتصال نوبیتکس (public endpoint)
```

صفحه `/admin/health` همه را تجمیع می‌کند.
