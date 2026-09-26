import Link from "next/link";

export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5">
        <div className="text-xl font-black">بات‌ترید</div>
        <div className="flex gap-3">
          <Link href="/login" className="rounded-xl px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800">ورود</Link>
          <Link href="/register" className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">ثبت‌نام</Link>
        </div>
      </header>
      <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <h1 className="max-w-3xl text-4xl font-black leading-tight md:text-6xl">
          معاملات خودکار روی <span className="text-primary">نوبیتکس</span>
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted">
          استراتژی بسازید، روی داده‌های تاریخی بک‌تست بگیرید و با مدیریت ریسک کامل به‌صورت زنده اجرا کنید — همه در یک پلتفرم فارسی.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link href="/register" className="rounded-2xl bg-primary px-8 py-3.5 font-bold text-primary-foreground shadow-lg shadow-primary/30">
            شروع رایگان
          </Link>
          <Link href="/marketplace" className="rounded-2xl border border-border px-8 py-3.5 font-bold">
            بازار استراتژی‌ها
          </Link>
        </div>
        <div className="mt-20 grid w-full grid-cols-1 gap-5 md:grid-cols-3">
          {[
            { t: "بک‌تست دقیق", d: "شبیه‌سازی واقعی با کارمزد، لغزش قیمت و تأخیر اجرا" },
            { t: "مدیریت ریسک", d: "حد ضرر، حد سود و تریلینگ استاپ برای هر معامله" },
            { t: "بازار استراتژی", d: "استراتژی‌های اثبات‌شده را بخرید یا بفروشید" },
          ].map((f) => (
            <div key={f.t} className="rounded-2xl border border-border bg-card p-6 text-right">
              <div className="text-lg font-bold">{f.t}</div>
              <div className="mt-2 text-sm text-muted">{f.d}</div>
            </div>
          ))}
        </div>
      </section>
      <footer className="border-t border-border py-6 text-center text-sm text-muted">
        بات‌ترید — پلتفرم معاملات الگوریتمی
      </footer>
    </main>
  );
}
