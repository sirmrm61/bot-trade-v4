import { PageHeader } from "@/components/ui";
import { ScalpPanel } from "./panel";

export default function ScalpingPage() {
  return (
    <div>
      <PageHeader
        title="اسکالپ اسکنر"
        description="ارزیابی و رتبه‌بندی جفت‌ارزها برای معاملات کوتاه‌مدت — ابزار تحلیل، نه توصیه معاملاتی"
      />
      <ScalpPanel />
    </div>
  );
}
