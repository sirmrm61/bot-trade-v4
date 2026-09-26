import { allSettings } from "@/modules/settings/service";
import { Card, PageHeader } from "@/components/ui";
import { SettingField } from "./setting-field";

export default async function AdminSettingsPage() {
  const settings = await allSettings();

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="تنظیمات سیستم" description="مقادیر کلیدی سیستم — تغییرات بلافاصله اعمال می‌شوند" />
      <Card>
        <div className="divide-y divide-border">
          {Object.entries(settings).map(([key, s]) => (
            <SettingField key={key} name={key} value={s.value} description={s.description} />
          ))}
        </div>
      </Card>
    </div>
  );
}
