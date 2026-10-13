/**
 * Application error codes → Persian user-facing messages.
 * Internal codes are logged; UI only ever shows the Persian message.
 */

export const ERROR_MESSAGES: Record<string, string> = {
  UNKNOWN: "خطای غیرمنتظره‌ای رخ داد. لطفاً دوباره تلاش کنید.",
  VALIDATION: "اطلاعات وارد شده معتبر نیست.",
  UNAUTHORIZED: "برای دسترسی به این بخش باید وارد حساب کاربری شوید.",
  FORBIDDEN: "شما مجاز به انجام این عملیات نیستید.",
  NOT_FOUND: "مورد درخواستی یافت نشد.",
  USERNAME_TAKEN: "این نام کاربری قبلاً ثبت شده است.",
  EMAIL_TAKEN: "این ایمیل قبلاً ثبت شده است.",
  INVALID_CREDENTIALS: "نام کاربری یا رمز عبور اشتباه است.",
  INSUFFICIENT_BALANCE: "موجودی کیف پول کافی نیست.",
  INSUFFICIENT_QUOTA: "سهمیه بک‌تست شما به پایان رسیده است.",
  LIVE_LIMIT_REACHED: "به حداکثر تعداد استراتژی فعال پلن خود رسیده‌اید.",
  SUBSCRIPTION_EXPIRED: "اشتراک شما به پایان رسیده است. برای ادامه، اشتراک تمدید کنید.",
  NO_EXCHANGE_ACCOUNT: "ابتدا حساب نوبیتکس خود را متصل کنید.",
  EXCHANGE_CONNECTION_FAILED: "اتصال به صرافی برقرار نشد. کلید API را بررسی کنید.",
  NOBITEX_INVALID_ORDER_SIZE: "حجم سفارش با حداقل حجم مجاز این بازار مطابقت ندارد.",
  NOBITEX_INSUFFICIENT_BALANCE: "موجودی حساب صرافی برای این سفارش کافی نیست.",
  NOBITEX_RATE_LIMITED: "تعداد درخواست‌ها به صرافی از حد مجاز بیشتر شد. کمی بعد تلاش کنید.",
  ORDER_REJECTED: "سفارش توسط صرافی رد شد.",
  STRATEGY_NOT_READY: "استراتژی برای اجرای زنده آماده نیست.",
  MARKETPLACE_NOT_APPROVED: "این استراتژی هنوز برای انتشار تأیید نشده است.",
  CANNOT_BUY_OWN_STRATEGY: "نمی‌توانید استراتژی خودتان را خریداری کنید.",
  RISK_VIOLATION: "سفارش با محدودیت‌های مدیریت ریسک سازگار نیست.",
  CIRCUIT_BREAKER_OPEN: "به دلیل خطاهای متوالی صرافی، ارسال سفارش موقتاً متوقف شده است.",
  DUPLICATE_OPERATION: "این عملیات قبلاً انجام شده است.",
  INVALID_TIMEFRAME: "بازه زمانی انتخاب‌شده در این نسخه پشتیبانی نمی‌شود.",
  INSUFFICIENT_DATA: "داده تاریخی کافی برای این بازه/نماد در صرافی یافت نشد.",
  STALE_DATA: "داده‌ی بازار کهنه است — آخرین کندل قدیمی‌تر از دو برابر تایم‌فریم است.",
  STRATEGY_HAS_LIVE: "استراتژی اجرای زنده‌ی فعال دارد — ابتدا آن را متوقف کنید.",
};

export class AppError extends Error {
  constructor(
    public code: keyof typeof ERROR_MESSAGES | string,
    public status = 400,
    public context?: Record<string, unknown>,
    /** user-facing specifics (safe to render) — why THIS request failed */
    public detail?: string,
  ) {
    super(code);
    this.name = "AppError";
  }
  get userMessage(): string {
    return ERROR_MESSAGES[this.code] ?? ERROR_MESSAGES.UNKNOWN;
  }
}

export function userMessage(err: unknown): string {
  if (err instanceof AppError) return err.userMessage;
  return ERROR_MESSAGES.UNKNOWN;
}

export function httpStatus(err: unknown): number {
  if (err instanceof AppError) return err.status;
  return 500;
}
