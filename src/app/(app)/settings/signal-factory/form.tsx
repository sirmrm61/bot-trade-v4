"use client";

import { ApiForm, Field, Input, Select } from "@/components/client";
import { EXCHANGE_LABELS, EXCHANGE_IDS, SIGNAL_TIMEFRAMES } from "@/shared/constants";

export interface SignalFactoryFormConfig {
  exchange: string;
  marketType: string;
  quote: string;
  minVolume24h: number;
  scanEveryHours: number;
  enabled: boolean;
  liveTradingEnabled: boolean;
  timeframes: string[];
}

const TF_LABELS: Record<string, string> = {
  "15m": "۱۵ دقیقه",
  "30m": "۳۰ دقیقه",
  "1h": "۱ ساعت",
  "4h": "۴ ساعت",
  "1d": "روزانه",
};

export function SignalFactoryForm({ config }: { config: SignalFactoryFormConfig }) {
  return (
    <ApiForm endpoint="/api/signal-factory/config" submitLabel="ذخیره تنظیمات">
      <Field label="صرافی">
        <Select
          name="exchange"
          defaultValue={config.exchange}
          options={EXCHANGE_IDS.map((id) => ({ value: id, label: EXCHANGE_LABELS[id] }))}
        />
      </Field>
      <Field label="نوع بازار">
        <Select
          name="marketType"
          defaultValue={config.marketType}
          options={[
            { value: "SPOT", label: "اسپات (SPOT)" },
            { value: "FUTURES", label: "فیوچرز (FUTURES)" },
          ]}
        />
      </Field>
      <Field label="ارز پایه (Quote)">
        <Input name="quote" defaultValue={config.quote} dir="ltr" required placeholder="USDT" />
      </Field>
      <Field label="حداقل حجم ۲۴ ساعته" hint="فیلتر نقدشوندگی — ۰ یعنی بدون فیلتر">
        <Input
          name="minVolume24h"
          type="number"
          min={0}
          step="any"
          defaultValue={config.minVolume24h}
          dir="ltr"
        />
      </Field>
      <Field label="تایم‌فریم‌های تحلیل" hint="تایم‌فریم اول، مرجع تأیید ستاپ است">
        <div className="flex flex-wrap gap-3 pt-1">
          {SIGNAL_TIMEFRAMES.map((tf) => (
            <label key={tf} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                name={`tf:${tf}`}
                defaultChecked={config.timeframes.includes(tf)}
                className="size-4 accent-primary"
              />
              {TF_LABELS[tf] ?? tf}
            </label>
          ))}
        </div>
      </Field>
      <Field label="دوره‌ی اسکن (ساعت)">
        <Input
          name="scanEveryHours"
          type="number"
          min={1}
          max={168}
          defaultValue={config.scanEveryHours}
          dir="ltr"
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="enabled" defaultChecked={config.enabled} className="size-4 accent-primary" />
        سیستم فعال باشد
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="liveTradingEnabled"
          defaultChecked={config.liveTradingEnabled}
          className="size-4 accent-primary"
        />
        معاملات واقعی (LIVE) — فقط با تأیید جداگانه‌ی هر الگو اجرا می‌شود
      </label>
    </ApiForm>
  );
}
