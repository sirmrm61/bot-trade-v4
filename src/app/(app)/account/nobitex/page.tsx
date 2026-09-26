import { prisma } from "@/infrastructure/database/prisma";
import { currentSession } from "@/modules/auth/session";
import { Card, CardTitle, PageHeader, StatusBadge } from "@/components/ui";
import { jalaliDateTime } from "@/shared/jalali";
import { ConnectForm, TestButton, DisconnectButton } from "./actions";

export default async function NobitexPage() {
  const session = await currentSession();
  const account = await prisma.exchangeAccount.findFirst({
    where: { userId: session!.sub },
  });

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="اتصال نوبیتکس" description="کلید API خود را متصل کنید — اطلاعات رمزنگاری‌شده ذخیره می‌شود" />

      <Card>
        {account ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-bold">{account.label}</div>
                <div className="mt-1 text-sm text-muted ltr">{account.apiKeyMask}</div>
              </div>
              <StatusBadge status={account.status} />
            </div>
            <div className="text-xs text-muted">
              آخرین بررسی: {jalaliDateTime(account.lastCheckedAt)}
            </div>
            <div className="flex gap-3">
              <TestButton />
              <DisconnectButton />
            </div>
          </div>
        ) : (
          <>
            <CardTitle>کلید API نوبیتکس</CardTitle>
            <p className="mb-4 text-sm text-muted">
              از پنل نوبیتکس یک توکن API با دسترسی «فقط معامله» بسازید. دسترسی برداشت را هرگز فعال نکنید.
            </p>
            <ConnectForm />
          </>
        )}
      </Card>

      <Card className="mt-4 border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <div className="text-sm text-amber-800 dark:text-amber-200">
          <b>نکته امنیتی:</b> کلیدها با رمزنگاری AES-256-GCM ذخیره می‌شوند و حتی مدیر سیستم هم نمی‌تواند مقدار خام آن‌ها را ببیند.
        </div>
      </Card>
    </div>
  );
}
