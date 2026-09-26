# ماژول اندیکاتورهای تکنیکال

پیاده‌سازی خالص (pure functions) اندیکاتورها + رجیستری + اتصال به موتور سیگنال.
همه توابع روی آرایه‌ی `Candle` کار می‌کنند و خروجی هم‌طول ورودی برمی‌گردانند
(مقادیر پیش از پر شدن پنجره = `NaN`).

## فایل‌ها

| فایل | نقش |
|------|-----|
| `engine.ts` | محاسبات: SMA، EMA، RSI، MACD، Bollinger، VWAP، ATR، Stochastic، OBV + `computeIndicator` + `evaluateCondition` + `defaultScore` |
| `registry.ts` | رجیستری متادیتا — UI سازنده استراتژی از همین‌جا کارت‌ها را می‌سازد |

## اندیکاتورها

| کلید | نوع | پارامترها | پیش‌فرض | نقش |
|------|-----|-----------|---------|-----|
| RSI | اسیلاتور | period | 7 | سیگنال |
| EMA / SMA | روی قیمت | period | 9 / 50 | سیگنال |
| MACD | اسیلاتور | fastPeriod, slowPeriod, signalPeriod | 12/26/9 | سیگنال |
| BOLLINGER | روی قیمت | period, stdDev | 20/2 | سیگنال |
| VWAP | روی قیمت | — (روزانه reset) | — | سیگنال |
| STOCHASTIC | اسیلاتور | kPeriod, dPeriod, smoothing | 5/3/3 | سیگنال |
| OBV | اسیلاتور | period (برای SMA مرجع) | 20 | سیگنال |
| ATR | — | period, slMultiplier, tpMultiplier | 14/1.5/2.5 | **ریسک** — فقط SL/TP پویا |

## چرخه‌ی داده

```
کندل‌ها → computeIndicator(name, params, candles) → IndicatorSeries {values, secondary}
        → evaluateCondition / defaultScore → امتیاز ∈ [-1, +1]
        → computeSignal (signals/engine.ts) → Σ(score×weight)/Σweight → BUY/SELL/HOLD
```

- `secondary` سری مرجع برای شرط‌های `cross_above`/`cross_below` است (مثل خط سیگنال MACD یا %D استوکستیک یا خودِ قیمت برای MAها).
- `ATR` در `NON_SCORING` ثبت است و هرگز در امتیاز سیگنال شرکت نمی‌کند — فقط برای `slPrice = entry − ATR×slMult` و `tpPrice = entry + ATR×tpMult` در موتور بک‌تست و لایو استفاده می‌شود (`atrStopsFromIndicators` در `backtest/service.ts`).

## افزودن اندیکاتور جدید

1. تابع محاسبه در `engine.ts` بنویسید — امضا: `(candles: Candle[], ...params) => number[]` یا آبجکت چندسری.
2. در `computeIndicator()` یک `case` با نام کلید اضافه کنید (خروجی `IndicatorSeries`).
3. در `defaultScore()` نگاشت به `[-1,+1]` بنویسید — یا اگر ابزار ریسک است، کلید را به `NON_SCORING` اضافه کنید.
4. در `registry.ts` یک `IndicatorDef` ثبت کنید — UI، ولیدیشن و چارت به‌صورت خودکار آن را می‌شناسند.
5. کلید را به `INDICATORS` در `src/shared/constants.ts` (لیست سفید اعتبارسنجی API) اضافه کنید.
6. اگر روی نمودار بک‌تست دیده شود، در `backtest/chart-data.ts` نگاشت به overlay/oscillator بدهید.
7. تست واحد در `tests/indicators.test.ts` با مقدار مرجع بنویسید.

## ذخیره‌سازی

پیکربندی هر اندیکاتور در جدول `StrategyIndicator` ذخیره می‌شود:
`{ name, parameters: JSON, weight, enabled, buyCondition: JSON, sellCondition: JSON }`
— معادل `indicators_config` ولی به‌صورت سطرهای رابطه‌ای (کوئری‌پذیر و نسخه‌بندی‌شده).
