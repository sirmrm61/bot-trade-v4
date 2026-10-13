"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/shared/utils";
import {
  Gauge, Wallet, Robot, Flask, Lightning, ArrowsLeftRight, Storefront,
  ShoppingBag, UsersThree, Bell, Question, SignOut, UserCircle, Key, ShieldCheck,
  Moon, Sun, List, ChartLineUp, GearSix, HardDrives, Crosshair, Brain, Factory,
} from "@phosphor-icons/react";

const NAV = [
  { href: "/dashboard", label: "داشبورد", icon: Gauge },
  { href: "/wallet", label: "کیف پول", icon: Wallet },
  { href: "/plans", label: "پلن‌ها", icon: ChartLineUp },
  { href: "/account", label: "صرافی‌ها", icon: Key },
  { href: "/strategies", label: "استراتژی‌ها", icon: Robot },
  { href: "/backtests", label: "بک‌تست‌ها", icon: Flask },
  { href: "/live", label: "معاملات زنده", icon: Lightning },
  { href: "/trades", label: "تاریخچه معاملات", icon: ArrowsLeftRight },
  { href: "/scalping", label: "اسکالپ اسکنر", icon: Crosshair },
  { href: "/smart-trader", label: "تریدر هوشمند", icon: Brain },
  { href: "/settings/signal-factory", label: "سیگنال‌ساز", icon: Factory },
  { href: "/marketplace", label: "بازار استراتژی", icon: Storefront },
  { href: "/purchases", label: "خریدهای من", icon: ShoppingBag },
  { href: "/referrals", label: "دعوت دوستان", icon: UsersThree },
  { href: "/notifications", label: "اعلان‌ها", icon: Bell },
  { href: "/help", label: "راهنما", icon: Question },
];

const ADMIN_NAV = [
  { href: "/admin", label: "داشبورد ادمین", icon: Gauge },
  { href: "/admin/users", label: "کاربران", icon: UserCircle },
  { href: "/admin/plans", label: "پلن‌ها", icon: ChartLineUp },
  { href: "/admin/subscriptions", label: "اشتراک‌ها", icon: ShieldCheck },
  { href: "/admin/wallets", label: "کیف پول‌ها", icon: Wallet },
  { href: "/admin/transactions", label: "تراکنش‌ها", icon: ArrowsLeftRight },
  { href: "/admin/marketplace", label: "بازار", icon: Storefront },
  { href: "/admin/pairs", label: "جفت‌ارزها", icon: ArrowsLeftRight },
  { href: "/admin/overview", label: "نمای کلی", icon: Robot },
  { href: "/admin/workers", label: "ورکرها", icon: HardDrives },
  { href: "/admin/logs", label: "لاگ‌ها", icon: List },
  { href: "/admin/settings", label: "تنظیمات", icon: GearSix },
];

export function AppShell({ children, role }: { children: ReactNode; role: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [dark, setDark] = useState(false);
  const [open, setOpen] = useState(false);
  const isAdmin = pathname.startsWith("/admin");
  const nav = isAdmin ? ADMIN_NAV : NAV;

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const saved = localStorage.getItem("theme");
      if (saved === "dark" || (!saved && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
        setDark(true);
        document.documentElement.classList.add("dark");
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("theme", next ? "dark" : "light");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const sidebar = (
    <aside className="flex h-full w-64 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-2 border-b border-white/10 px-5">
        <ChartLineUp size={26} weight="bold" className="text-primary" />
        <span className="text-lg font-black text-white">بات‌ترید</span>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {nav.map((item) => {
          const active = pathname === item.href || (item.href !== "/dashboard" && item.href !== "/admin" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition",
                active ? "bg-primary text-white" : "hover:bg-white/10",
              )}
            >
              <item.icon size={20} weight={active ? "fill" : "regular"} />
              {item.label}
            </Link>
          );
        })}
        {role === "ADMIN" && !isAdmin && (
          <Link href="/admin" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-amber-400 hover:bg-white/10">
            <ShieldCheck size={20} />
            پنل مدیریت
          </Link>
        )}
        {isAdmin && (
          <Link href="/dashboard" className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-amber-400 hover:bg-white/10">
            <Gauge size={20} />
            پنل کاربری
          </Link>
        )}
      </nav>
      <div className="border-t border-white/10 p-3">
        <button onClick={logout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-red-400 hover:bg-white/10">
          <SignOut size={20} />
          خروج از حساب
        </button>
      </div>
    </aside>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* desktop sidebar */}
      <div className="hidden md:block">{sidebar}</div>
      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-72">{sidebar}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-card px-4 md:px-6">
          <button className="md:hidden" onClick={() => setOpen(true)} aria-label="منو">
            <List size={24} />
          </button>
          <div className="hidden text-sm text-muted md:block">
            پلتفرم طراحی و اجرای استراتژی‌های معاملاتی نوبیتکس
          </div>
          <button onClick={toggleTheme} aria-label="تغییر تم" className="rounded-xl border border-border p-2 hover:bg-slate-100 dark:hover:bg-slate-800">
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
