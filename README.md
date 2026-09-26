# بات‌ترید — پلتفرم معاملات خودکار نوبیتکس

پلتفرم فارسی و راست‌چین برای طراحی، بک‌تست و اجرای استراتژی‌های اسکالپ روی نوبیتکس.

---

## راهنمای اجرای پروژه

### پیش‌نیازها

| ابزار | نسخه | بررسی |
|-------|------|-------|
| Node.js | 24.x | `node -v` |
| npm | 11+ | `npm -v` |
| Docker Desktop | آخرین | `docker info` |

### روش ۱: اجرای محلی (توسعه)

```bash
# ۱. متغیرهای محیطی
cp .env.example .env
# کلید رمزنگاری را تولید و در .env جایگذاری کنید:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ۲. نصب و دیتابیس
npm install
npx prisma migrate deploy
npx prisma db seed          # پلن‌ها + کاربر admin

# ۳. Redis (از طریق Docker)
docker compose up -d redis

# ۴. اجرا — دو ترمینال
npm run dev                 # ترمینال ۱: وب → http://localhost:3000
npm run worker              # ترمینال ۲: پردازشگر صف‌ها
```

### روش ۲: اجرای کامل با Docker

```bash
cp .env.example .env        # ENCRYPTION_KEY را پر کنید
docker compose up -d --build   # app + worker + redis
# وب: http://localhost:3000
```

### ورود پیش‌فرض (seed)

| نقش | کاربر | رمز |
|-----|-------|-----|
| ادمین | `admin` | `admin123` — **فوراً عوض کنید** |

پلن‌های seed: رایگان (۷ روز)، پایه (۷/۱۵/۳۰ روز)، حرفه‌ای (۷/۱۵/۳۰ روز)، ویژه.

### بررسی سلامت

```bash
curl http://localhost:3000/api/health/database   # {"ok":true}
curl http://localhost:3000/api/health/redis     # {"ok":true}
curl http://localhost:3000/api/health/nobitex   # اتصال به نوبیتکس
curl http://localhost:3000/api/health/queues    # وضعیت صف‌ها
```

صفحه `/admin/health` هم همه را یکجا نشان می‌دهد (نیاز به ورود admin).

### تست‌ها

```bash
npm test            # vitest — ۲۱ تست (اندیکاتور، سیگنال، رمزنگاری، بک‌تست، کیف‌پول)
npx tsc --noEmit    # typecheck
npm run lint        # eslint
npm run build       # بیلد production
```

### کارهای رایج

```bash
npx prisma migrate dev --name <name>   # مهاجرت جدید در توسعه
npx prisma studio                      # بازکردن دیتابیس در مرورگر
docker compose logs -f worker          # لاگ ورکر در حالت docker
docker compose down                    # توقف همه سرویس‌ها
```

### نوبیتکس — تست‌نت در مقابل پروداکشن

- تست‌نت (پیش‌فرض): `NOBITEX_BASE_URL=https://testnetapiv2.nobitex.ir`
- پروداکشن: `NOBITEX_BASE_URL=https://apiv2.nobitex.ir`
- کلید API تست‌نت از پنل تست‌نت نوبیتکس بگیرید و در «اتصال نوبیتکس» وارد کنید.

### رفتن به پروداکشن (Postgres)

۱. در `docker-compose.yml` سرویس `db` (Postgres) را فعال کنید — پروفایل `postgres`
۲. `DATABASE_URL` را به `postgresql://bottrade:bottrade@db:5432/bottrade` تغییر دهید
۳. در `prisma/schema.prisma` provider را به `postgresql` تغییر دهید و adapter را در `src/infrastructure/database/prisma.ts` به `@prisma/adapter-pg` عوض کنید
۴. `npx prisma migrate deploy`

---

## ساختار

```
src/app            — Next.js App Router (RTL، فونت وزیرمتن)
src/modules        — دامنه: auth، wallet، trading، backtest، signals، ...
src/infrastructure — prisma، redis، crypto، logger، queues
src/workers        — پردازشگرهای BullMQ (۹ صف + schedulerها)
prisma/            — schema + migrations + seed
tests/             — vitest
docs/              — مستندات فنی
```

## مستندات

- [docs/architecture.md](docs/architecture.md) — معماری و ADR
- [docs/security.md](docs/security.md) — مدل تهدید و امنیت
- [docs/database.md](docs/database.md) — اسکیمای دیتابیس
- [docs/queues.md](docs/queues.md) — قرارداد صف‌ها
- [docs/recovery.md](docs/recovery.md) — نقشه بازیابی
- [docs/testing.md](docs/testing.md) — نقشه تست
