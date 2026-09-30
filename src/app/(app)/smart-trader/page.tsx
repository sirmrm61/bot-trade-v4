import { PageHeader } from "@/components/ui";
import { SmartTraderMosaic } from "./mosaic";

export default function SmartTraderPage() {
  return (
    <div>
      <PageHeader
        title="تریدر هوشمند"
        description="ایده‌های معاملاتی خودکار — روی هر کارت کلیک کنید تا اجرا شود"
      />
      <SmartTraderMosaic />
    </div>
  );
}
