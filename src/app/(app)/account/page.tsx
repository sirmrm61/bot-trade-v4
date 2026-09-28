import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { EXCHANGES } from "@/modules/exchanges/registry";
import { ConnectForm, TestButton, DisconnectButton } from "./actions";

export default async function AccountPage() {
  const session = await currentSession();
  const accounts = await prisma.exchangeAccount.findMany({
    where: { userId: session!.sub, status: { not: "DISCONNECTED" } },
  });
  const byExchange = new Map(accounts.map((a) => [a.exchange, a]));

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title="صرافی‌ها"
        description="کلید API هر صرافی را جداگانه متصل و تست کنید — اطلاعات رمزنگاری‌شده ذخیره می‌شود"
      />

      {EXCHANGES.map((ex) => {
        const account = byExchange.get(ex.id);
        return (
          <Card key={ex.id}>
            {account ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-bold">{ex.label}</div>
                    <div className="mt-1 text-sm text-muted ltr">{account.apiKeyMask}</div>
                  </div>
                  <StatusBadge status={account.status} />
                </div>
                <div className="text-xs text-muted">
                  آخرین بررسی: {account.lastCheckedAt ? jalaliDateTime(account.lastCheckedAt) : "—"}
                </div>
                {account.lastError && (
                  <div className="text-xs text-danger">{account.lastError}</div>
                )}
                <div className="flex gap-3">
                  <TestButton exchange={ex.id} />
                  <DisconnectButton exchange={ex.id} />
                </div>
              </div>
            ) : (
              <>
                <CardTitle>اتصال {ex.label}</CardTitle>
                <p className="mb-4 text-sm text-muted">
                  {ex.hint}. دسترسی برداشت (Withdraw) را هرگز فعال نکنید.
                </p>
                <ConnectForm exchange={ex.id} needsPassphrase={ex.needsPassphrase} />
              </>
            )}
          </Card>
        );
      })}

      <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <div className="text-sm text-amber-800 dark:text-amber-200">
          <b>نکته امنیتی:</b> کلیدها با رمزنگاری AES-256-GCM ذخیره می‌شوند و حتی مدیر سیستم هم نمی‌تواند مقدار خام آن‌ها را ببیند.
        </div>
      </Card>
    </div>
  );
}
