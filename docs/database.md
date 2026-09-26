# مستندات دیتابیس

Prisma schema در `prisma/schema.prisma` — ۲۲ مدل.

## جریان اصلی

```
User ──┬── Wallet ── WalletTransaction (ledger)
       ├── UserSubscription ── Plan
       ├── UserPlanOverride (override plan limits per user)
       ├── ExchangeAccount (credentials encrypted)
       ├── Strategy ── StrategyVersion ── StrategyIndicator
       │                    ├── MarketplaceListing ── StrategyPurchase
       │                    ├── Backtest ── BacktestTrade
       │                    └── LiveStrategy ── Order ── Trade
       ├── Referral (referrer/referee)
       ├── Notification
       └── ActivityLog
Pair ── Candle (OHLCV)
SystemSetting (key-value)
```

## نکات کلیدی

### Wallet ledger

هر تراکنش `balanceBefore`/`balanceAfter` دارد؛ موجودی = آخرین `balanceAfter`. تابع `verifyLedger` کل زنجیره را بازمحاسبه می‌کند و هر ناسازگاری را گزارش می‌دهد.

### Strategy versioning

هر استراتژی چند نسخه دارد؛ فقط آخرین نسخه فعال است. کلون/خرید نسخه جدید می‌سازد و `parentVersionId` را نگه می‌دارد تا «تغییرات مادی» برای فروش مجدد قابل بررسی باشد.

### LiveStrategy status

`ACTIVE | PAUSED | STOPPED | ERROR`
- PAUSED: معامله جدید نمی‌گیرد ولی پوزیشن باز را مدیریت می‌کند (SL/TP/trailing)
- STOPPED: رفتار قابل تنظیم — `CANCEL_ALL` یا `KEEP_MANAGING` برای پوزیشن باز

### Order lifecycle

`PENDING → SUBMITTED → PARTIALLY_FILLED → FILLED | CANCELLED | REJECTED | EXPIRED`

### Idempotency

`WalletTransaction.idempotencyKey` و `Order.idempotencyKey` یکتا — تکرار امن است.

## مایگریشن

```bash
npx prisma migrate dev --name <name>   # توسعه
npx prisma migrate deploy              # تولید
npx prisma db seed                     # داده اولیه (پلن‌ها، admin)
```
