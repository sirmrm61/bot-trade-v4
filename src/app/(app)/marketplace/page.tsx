import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, Badge, EmptyState } from "@/components/ui";
import { toman, faPercent, faNumber } from "@/shared/utils";
import { BuyButton } from "./actions";

export default async function MarketplacePage() {
  const session = await currentSession();
  const listings = await prisma.marketplaceListing.findMany({
    where: { status: "PUBLISHED" },
    orderBy: { publishedAt: "desc" },
    include: {
      seller: { select: { username: true } },
      version: { select: { symbol: true, timeframe: true, versionNumber: true } },
      strategy: {
        select: {
          backtests: { where: { status: "COMPLETED" }, orderBy: { completedAt: "desc" }, take: 1,
            select: { profitPct: true, winRate: true, maxDrawdown: true, totalTrades: true } },
        },
      },
      purchases: { where: { buyerId: session!.sub }, select: { id: true } },
    },
  });

  return (
    <div>
      <PageHeader title="بازار استراتژی" description="استراتژی‌های تأییدشده را خریداری کنید" />
      {listings.length === 0 ? (
        <EmptyState title="استراتژی منتشرشده‌ای وجود ندارد" hint="استراتژی‌های تأییدشده اینجا نمایش داده می‌شوند" />
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {listings.map((l) => {
            const bt = l.strategy.backtests[0];
            const owned = l.purchases.length > 0;
            return (
              <Card key={l.id} className="flex flex-col">
                <div className="flex items-start justify-between">
                  <CardTitle className="mb-1">{l.title}</CardTitle>
                  <Badge tone="info" >{l.version.symbol}</Badge>
                </div>
                <div className="text-xs text-muted">
                  فروشنده: {l.seller.username} · تایم‌فریم {l.version.timeframe} · v{l.version.versionNumber}
                </div>
                {l.description && <p className="mt-3 text-sm text-muted">{l.description}</p>}
                {bt && (
                  <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3 text-center dark:bg-slate-800/50">
                    <div>
                      <div className="text-xs text-muted">سود بک‌تست</div>
                      <div className={`font-black ${bt.profitPct! >= 0 ? "text-success" : "text-danger"}`}>{faPercent(bt.profitPct)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">نرخ برد</div>
                      <div className="font-black">{faPercent(bt.winRate)}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted">حداکثر افت</div>
                      <div className="font-black text-danger">{faPercent(bt.maxDrawdown)}</div>
                    </div>
                  </div>
                )}
                <div className="mt-4 flex items-center justify-between">
                  <div className="text-xl font-black">{l.price === 0 ? "رایگان" : toman(l.price)}</div>
                  <div className="text-xs text-muted">{l.subscriptionDays > 0 ? `${faNumber(l.subscriptionDays)} روز دسترسی` : "دائمی"}</div>
                </div>
                <div className="mt-4">
                  {owned ? (
                    <div className="rounded-xl bg-emerald-50 py-2 text-center text-sm font-bold text-success dark:bg-emerald-950/30">خریداری‌شده ✓</div>
                  ) : (
                    <BuyButton listingId={l.id} />
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
