import { Card, PageHeader } from "@/components/ui";
import { WorkersPanel } from "@/components/workers-panel";

export default function AdminWorkersPage() {
  return (
    <div>
      <PageHeader
        title="ورکرها"
        description="وضعیت صف‌های BullMQ و پروسه‌ی ورکر + اجرا، توقف موقت و توقف کامل + لاگ سیستم"
      />
      <Card>
        <WorkersPanel />
      </Card>
    </div>
  );
}
