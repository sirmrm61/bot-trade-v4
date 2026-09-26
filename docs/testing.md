# نقشه تست

## اجرا

```bash
npm test           # vitest — ۲۱ تست
npx tsc --noEmit   # typecheck
npm run build      # build کامل
```

## پوشش فعلی

| فایل | چیزهای تست‌شده |
|------|----------------|
| `tests/indicators.test.ts` | SMA, EMA, RSI, MACD, Bollinger، evaluateCondition |
| `tests/signal.test.ts` | weighted scoring، thresholds، HOLD، normalize |
| `tests/crypto.test.ts` | AES-256-GCM roundtrip، random IV، tamper detection، masking |
| `tests/backtest.test.ts` | اجرای کامل backtest، metricها، fee، عدم موجودی منفی |
| `tests/wallet.test.ts` | ledger با DB واقعی، running balance، رد موجودی منفی، idempotency |

## تست‌های پیشنهادی بعدی

- integration تست route ها با Next test harness
- mock Nobitex برای order engine
- E2E با Playwright برای جریان register→connect→strategy→backtest
- property-based تست روی wallet ledger (fast-check)
