# مدل تهدید و امنیت

## دارایی‌های بحرانی

1. **کلیدهای API نوبیتکس کاربران** — نشت = سرقت دارایی
2. **موجودی کیف‌پول داخلی** — دستکاری = زیان مالی
3. **سشن‌های کاربر** — سرقت = دسترسی کامل

## کنترل‌ها

### رمزنگاری credential صرافی

- AES-256-GCM، IV تصادفی ۱۲ بایتی به‌ازای هر رمزنگاری
- کلید فقط در env (`ENCRYPTION_KEY`)، هرگز در DB/لاگ/UI
- فرمت ذخیره: `iv.tag.ciphertext` (base64)
- `maskSecret()` برای نمایش — فقط ۴ کاراکتر اول/آخر
- تست roundtrip و tamper-detection در `tests/crypto.test.ts`

### لاگ‌گیری امن

- `sanitize()` در logger کلیدهای حساس (`secret`, `apikey`, `token`, ...) را `[REDACTED]` می‌کند
- هیچ secret در پیام خطا یا response نمی‌رود

### احراز هویت

- bcryptjs (cost 12) برای رمز
- سشن JWT در کوکی httpOnly، امضا با `SESSION_SECRET`
- معماری آماده 2FA (فیلد `totpSecret` رمزنگاری‌شده در مدل User)
- proxy.ts کوکی سشن را برای مسیرهای محافظت‌شده بررسی می‌کند؛ صفحات هم در layout دوباره چک می‌کنند

### idempotency

عملیات حساس `idempotencyKey` قبول می‌کنند و کلید یکتا در DB ذخیره می‌شود:

| عملیات | کلید |
|--------|------|
| ثبت سفارش | `Order.idempotencyKey` |
| شارژ کیف‌پول | `WalletTransaction.idempotencyKey` |
| خرید استراتژی | `StrategyPurchase` transaction guard |
| خرید اشتراک | `Subscription` transaction guard |

تکرار درخواست با همان کلید → همان نتیجه قبلی، بدون اثر دوم.

### Rate limiting

- `rateLimit()` در `exchanges/rate-limiter.ts` — سطل توکن بر مبنای Redis
- سطح‌ها: exchange, endpoint, user, worker
- Circuit breaker: ۵ شکست متوالی → ۶۰ ثانیه قطع

### سطوح دسترسی

- `role` روی User: USER / ADMIN / SUPER_ADMIN
- layout ادمین و APIها نقش را چک می‌کنند
- کاربر `SUSPENDED` یا اشتراک `EXPIRED` → فقط مشاهده

## موارد باقی‌مانده (production hardening)

- [ ] HTTPS اجباری + کوکی `Secure` (فعلاً `NODE_ENV`-dependent)
- [ ] 2FA واقعی (TOTP)
- [ ] تایید موبایل با OTP
- [ ] Webhook signature برای Telegram
- [ ] اسکن secrets در CI
- [ ] رفع آسیب‌پذیری‌های npm audit (۱۳ مورد — بررسی `npm audit`)
