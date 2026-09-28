/** Domain constants — single source of truth for statuses & enums. */

export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** Whitelist of supported indicators — kept in sync with modules/indicators/registry.ts */
export const INDICATORS = ["RSI", "EMA", "SMA", "MACD", "BOLLINGER", "VWAP", "STOCHASTIC", "OBV", "ATR"] as const;
export type IndicatorName = (typeof INDICATORS)[number];

/** Strategy engine kinds — SIGNAL uses candle indicators; OBI/MM are order-book driven;
 *  the SYMBOLIC_* kinds are candle-native symbolic engines (see modules/trading/symbolic-engines). */
export const STRATEGY_KINDS = ["SIGNAL", "ORDER_BOOK_IMBALANCE", "MARKET_MAKING", "ATM_SME", "RMM_BSE", "DZS_HMM"] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

export const STRATEGY_KIND_LABELS: Record<StrategyKind, string> = {
  SIGNAL: "سیگنالی (اندیکاتورها)",
  ORDER_BOOK_IMBALANCE: "عدم تعادل دفتر سفارش",
  MARKET_MAKING: "مارکت میکر",
  ATM_SME: "سمبلیک مومنتوم (ATM-SME)",
  RMM_BSE: "سمبلیک شکست کانال (RMM-BSE)",
  DZS_HMM: "سمبلیک رژیم بازار (DZS-HMM)",
};

/** Exchanges with an adapter in modules/exchanges — drives strategy exchange picker. */
export const EXCHANGE_IDS = ["NOBITEX", "KUCOIN"] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];
export const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  NOBITEX: "نوبیتکس",
  KUCOIN: "کوکوین",
};

export const STRATEGY_STATUS = {
  DRAFT: "DRAFT",
  BACKTESTING: "BACKTESTING",
  READY: "READY",
  LIVE: "LIVE",
  PAUSED: "PAUSED",
  STOPPING: "STOPPING",
  STOPPED: "STOPPED",
  ERROR: "ERROR",
  EXPIRED: "EXPIRED",
} as const;

export const ORDER_STATUS = {
  PENDING: "PENDING",
  SUBMITTED: "SUBMITTED",
  PARTIALLY_FILLED: "PARTIALLY_FILLED",
  FILLED: "FILLED",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  CANCELLED: "CANCELLED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  ERROR: "ERROR",
} as const;

export const SUBSCRIPTION_STATUS = {
  TRIAL: "TRIAL",
  ACTIVE: "ACTIVE",
  EXPIRING: "EXPIRING",
  EXPIRED: "EXPIRED",
  GRACE_PERIOD: "GRACE_PERIOD",
  RESTRICTED: "RESTRICTED",
  SUSPENDED: "SUSPENDED",
} as const;

export const LISTING_STATUS = {
  DRAFT: "DRAFT",
  PENDING_REVIEW: "PENDING_REVIEW",
  APPROVED: "APPROVED",
  PUBLISHED: "PUBLISHED",
  REJECTED: "REJECTED",
  SUSPENDED: "SUSPENDED",
  ARCHIVED: "ARCHIVED",
} as const;

export const TX_TYPES = {
  CHARGE: "CHARGE",
  STRATEGY_PURCHASE: "STRATEGY_PURCHASE",
  STRATEGY_SALE: "STRATEGY_SALE",
  PLATFORM_COMMISSION: "PLATFORM_COMMISSION",
  SUBSCRIPTION: "SUBSCRIPTION",
  REFUND: "REFUND",
  REFERRAL_BONUS: "REFERRAL_BONUS",
  MANUAL_ADJUSTMENT: "MANUAL_ADJUSTMENT",
  WITHDRAWAL: "WITHDRAWAL",
} as const;

export const TX_TYPE_LABELS: Record<string, string> = {
  CHARGE: "شارژ حساب",
  STRATEGY_PURCHASE: "خرید استراتژی",
  STRATEGY_SALE: "فروش استراتژی",
  PLATFORM_COMMISSION: "سهم سایت",
  SUBSCRIPTION: "خرید اشتراک",
  REFUND: "بازگشت وجه",
  REFERRAL_BONUS: "پاداش رفرال",
  MANUAL_ADJUSTMENT: "اصلاح دستی موجودی",
  WITHDRAWAL: "برداشت وجه",
};

export const DEFAULT_SETTINGS = {
  GRACE_PERIOD_DAYS: { value: 3, description: "مدت مهلت ارفاق پس از انقضای اشتراک (روز)" },
  COMMISSION_PCT: { value: 20, description: "سهم پیش‌فرض سایت از فروش استراتژی (٪)" },
  REFERRAL_BONUS_DAYS: { value: 7, description: "پاداش رفرال موفق (روز)" },
  LIMIT_MAX_MODIFY: { value: 5, description: "حداکثر تعداد اصلاح سفارش Limit" },
  LIMIT_MAX_WAIT_MIN: { value: 30, description: "حداکثر مدت انتظار سفارش Limit (دقیقه)" },
  LIMIT_CHECK_INTERVAL_SEC: { value: 20, description: "فاصله بررسی سفارش Limit (ثانیه)" },
  CIRCUIT_BREAKER_THRESHOLD: { value: 5, description: "تعداد خطای متوالی API برای فعال شدن Circuit Breaker" },
  LIVE_TICK_SEC: { value: 20, description: "فاصله زمانی چرخه اجرای استراتژی زنده (ثانیه)" },
  BACKTEST_FEE_PCT: { value: 0.25, description: "کارمزد پیش‌فرض بک‌تست (٪)" },
  BACKTEST_SLIPPAGE_PCT: { value: 0.05, description: "لغزش قیمت پیش‌فرض بک‌تست (٪)" },
} as const;

export const SYSTEM_USER_ACTOR = "SYSTEM";
