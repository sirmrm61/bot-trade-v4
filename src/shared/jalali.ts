/**
 * Jalali (Persian) date/time formatting using the built-in Intl API
 * (persian calendar is supported natively in modern Node/browsers).
 */

const faDateFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

const faDateTimeFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const faShortFmt = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function jalaliDate(d: Date | string | number | null | undefined): string {
  if (!d) return "—";
  return faDateFmt.format(new Date(d));
}

export function jalaliDateTime(d: Date | string | number | null | undefined): string {
  if (!d) return "—";
  return faDateTimeFmt.format(new Date(d));
}

export function jalaliShort(d: Date | string | number | null | undefined): string {
  if (!d) return "—";
  return faShortFmt.format(new Date(d));
}

export function daysRemaining(until: Date | string | number): number {
  const ms = new Date(until).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
