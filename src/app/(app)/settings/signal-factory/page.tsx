import { currentSession } from "@/modules/auth/session";
import { getOrCreateConfig, configTimeframes } from "@/modules/signal-factory/config";
import { Card, CardTitle, PageHeader } from "@/components/ui";
import { SignalFactoryForm } from "./form";

export default async function SignalFactorySettingsPage() {
  const session = await currentSession();
  const cfg = await getOrCreateConfig(session!.sub);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title="سیستم سیگنال‌ساز"
        description="تنظیمات اسکنر ستاپ — صرافی، بازار، نقدشوندگی و دوره‌ی اسکن"
      />
      <Card>
        <CardTitle>پیکربندی اسکنر</CardTitle>
        <SignalFactoryForm
          config={{
            exchange: cfg.exchange,
            marketType: cfg.marketType,
            quote: cfg.quote,
            minVolume24h: cfg.minVolume24h,
            scanEveryHours: cfg.scanEveryHours,
            enabled: cfg.enabled,
            liveTradingEnabled: cfg.liveTradingEnabled,
            timeframes: configTimeframes(cfg),
          }}
        />
      </Card>
      <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/20">
        <div className="text-sm leading-6 text-amber-800 dark:text-amber-200">
          <b>توجه:</b> معاملات واقعی (LIVE) فقط بعد از تأیید بک‌تست، حداقل ۲۰ معامله‌ی
          کاغذی موفق و تأیید صریح شما فعال می‌شود. قوانین ریسک سیستم همیشه برترند.
        </div>
      </Card>
    </div>
  );
}
