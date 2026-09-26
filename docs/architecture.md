# معماری سیستم — بات‌ترید

## نمای کلی

پلتفرم طراحی، بک‌تست و اجرای استراتژی‌های اسکالپ روی نوبیتکس. فارسی و راست‌چین.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Next.js 16 │────▶│  API Routes  │────▶│   Modules    │
│  (App Router│     │  (api/*)     │     │ (domain svc) │
│   RTL UI)   │     └──────┬───────┘     └──────┬──────┘
└─────────────┘            │                    │
                           ▼                    ▼
                     ┌──────────┐        ┌────────────┐
                     │  Prisma  │        │ Exchange   │
                     │ (SQLite/ │        │ Adapters   │
                     │ Postgres)│        │ (Nobitex)  │
                     └──────────┘        └────────────┘
                           ▲                    ▲
┌─────────────┐     ┌──────┴───────┐            │
│   Workers   │────▶│  BullMQ/Redis│────────────┘
│ (tsx proc.) │     └──────────────┘
└─────────────┘
```

## لایه‌ها

- `src/app` — رابط کاربری فارسی RTL (Vazirmatn) + API route ها
- `src/modules` — منطق دامنه: auth, wallet, strategies, signals, indicators, backtest, trading, marketplace, referrals, subscriptions, notifications, exchanges, settings, activity, pairs
- `src/infrastructure` — prisma client، رمزنگاری AES-256-GCM، لاگر ساخت‌یافته، redis، صف‌ها
- `src/workers` — پردازشگرهای BullMQ: بک‌تست، لایو، اعلان، ری‌کانسیل، پاک‌سازی، داده بازار
- `src/modules/system/workers.ts` — کنترل‌پلن ورکر برای ادمین (`/admin/workers`): وضعیت صف‌ها + ضربان پروسه، توقف‌موقت/ادامه/خالی‌کردن صف (`queue.pause/resume/drain`)، توقف کامل از طریق فلگ `worker:control:shutdown` که ورکر در حلقه‌ی تیک چک می‌کند، و «اجرای ورکر» که `npm run worker` را detached اجرا می‌کند. هر خط لاگ علاوه بر کنسول در لیست Redis به نام `system:logs` (۲۰۰۰ خط آخر) ذخیره می‌شود و در همان صفحه قابل مشاهده است — لاگر فیلد `proc` می‌گذارد (`worker`/`app`)
- `src/components` — کامپوننت‌های UI مشترک (Card, Table, Badge, Charts، شِل)

## جریان معامله

```
Signal → Risk Check → Order Builder → Exchange Validation → Submit → Track → Filled/Partial/Rejected
```

شش نوع استراتژی (`StrategyVersion.kind`) وجود دارد:
- `SIGNAL` — امتیاز وزنی اندیکاتورها روی کندل‌ها (پیش‌فرض)
- `ORDER_BOOK_IMBALANCE` — امتیاز عدم تعادل حجم bid/ask از سطوح برتر دفتر سفارش در هر تیک (`modules/trading/orderbook-imbalance.ts`)
- `MARKET_MAKING` — کوت دوطرفه‌ی Limit حول قیمت میانی با بازنشانی روی جابه‌جایی و سقف موجودی (`modules/trading/market-making.ts`)
- `ATM_SME` — موتور سمبلیک مومنتوم تطبیقی: بازده لگاریتمی نرمال‌شده با σ رولینگ → فشرده‌سازی `tanh` به `Vt ∈ [−1,1]` → توکن‌های A–E → الگوهای خستگی ۳توکنی (`[E,E,C]/[E,E,D]` لانگ، `[A,A,C]/[A,A,B]` خروج) + تایید EMA و گیت تاریخچه‌ی الگو (`modules/trading/symbolic-engines.ts`)
- `RMM_BSE` — شکست ساختاری مین/مکس رولینگ: موقعیت close در کانال k کندل قبلی → تشخیص فشردگی → ورود روی شکست+تایید حجم، حد ضرر روی مبنا/میانه‌ی کانال، خروج روی برگشت به کانال (`modules/trading/symbolic-engines.ts`)
- `DZS_HMM` — Z-score دینامیک + مدل مارکوف سه‌حالته (range/bull/bear): فیلتر پیشرو روی احتمال رژیم‌ها، ورود با آستانه‌ی احتمال، خروج با غلبه‌ی رژیم مخالف یا range (`modules/trading/symbolic-engines.ts`)

دفتر سفارش تاریخی وجود ندارد، پس بک‌تست دو نوع دفتری روی کندل‌ها **شبیه‌سازی** می‌شود: OBI با پروکسی عدم‌توازن کندل (موقعیت close در بازه‌ی [low,high] + EMA) از مسیر `signalFn` موتور بک‌تست، و MM با مدل فیل «برخورد بازه‌ی کندل به کوت» + تطبیق FIFO برای PnL تحقق‌یافته (`modules/backtest/mm-engine.ts`). سه موتور سمبلیک کندل‌محورند و بک‌تست واقعی دارند — `symbolicSignalFn` در همان مسیر `signalFn` موتور بک‌تست جایگذاری می‌شود. شرط «بک‌تست موفق قبل از لایو واقعی» برای همه‌ی انواع برقرار است. در حالت زنده، انواع سمبلیک از مسیر کندل (تایم‌فریم نسخه‌ی استراتژی) تیک می‌خورند و آخرین وضعیت (توکن‌ها، Mt، احتمالات رژیم) در `live.stats.last` ذخیره می‌شود.

`LiveStrategy.mode` دو مقدار دارد: `REAL` (سفارش واقعی) و `PAPER` (تست زنده). در حالت PAPER موتور فقط داده‌ی عمومی بازار را می‌خواند (`publicAdapter`)، هیچ سفارشی به صرافی نمی‌فرستد و معاملات/کوت‌ها شبیه‌سازی می‌شوند — برای OBI/سیگنال با قیمت تیکر، برای مارکت‌میکر با مدل فیل «عبور قیمت از کوت» و موجودی مجازی در `live.stats`.

محدوده‌ها: Rate limit در سطح صرافی/کاربر/ورکر/اندپوینت، Circuit breaker، retry با backoff+jitter، idempotency برای عملیات مالی.

## تصمیمات کلیدی (ADR خلاصه)

| # | تصمیم | دلیل |
|---|-------|------|
| 1 | Next.js 16 App Router + Server Components | رندر سرور، کوچک‌ترین JS سمت کلاینت |
| 2 | Prisma + SQLite (dev) / Postgres (prod) | مهاجرت آسان؛ فقط `DATABASE_URL` عوض شود |
| 3 | BullMQ روی Redis | صف پایدار، retry، job scheduler برای کران |
| 4 | AES-256-GCM برای API secretها | authenticated encryption؛ IV تصادفی |
| 5 | ExchangeAdapter interface | افزودن صرافی‌های بعدی بدون تغییر دامنه |
| 6 | Wallet ledger با running balance | جلوگیری از race condition؛ قابل audit |
| 7 | proxy.ts به‌جای middleware.ts | Next.js 16 — middleware منسوخ شده |
