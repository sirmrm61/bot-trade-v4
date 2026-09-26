import crypto from "node:crypto";

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Format a number with Persian digits + thousand separators (تومان). */
const faNum = new Intl.NumberFormat("fa-IR");
const faNumDec = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 });

export function toman(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${faNum.format(Math.round(n))} تومان`;
}

export function faNumber(n: number | null | undefined, dec = false): string {
  if (n === null || n === undefined) return "—";
  return dec ? faNumDec.format(n) : faNum.format(n);
}

export function faPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${faNumDec.format(n)}٪`;
}

/** Human-readable unique reference number for financial transactions. */
export function referenceNumber(prefix = "TRX"): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}

export function newId(): string {
  return crypto.randomUUID();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
