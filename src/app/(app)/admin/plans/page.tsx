import { prisma } from "@/infrastructure/database/prisma";
import { Card, CardTitle, PageHeader, Table, Badge } from "@/components/ui";
import { toman, faNumber } from "@/shared/utils";
import { PlanForm } from "./plan-form";

export default async function AdminPlansPage() {
  const plans = await prisma.plan.findMany({ orderBy: [{ sortOrder: "asc" }, { price: "asc" }] });

  return (
    <div>
      <PageHeader title="مدیریت پلن‌ها" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>پلن‌های موجود</CardTitle>
          <Table headers={["نام", "قیمت", "مدت", "بک‌تست", "لایو", "وضعیت", "ویرایش"]}>
            {plans.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-3 font-bold">{p.name}<div className="text-xs text-muted ltr">{p.slug}</div></td>
                <td className="px-4 py-3">{toman(p.price)}</td>
                <td className="px-4 py-3">{faNumber(p.durationDays)} روز</td>
                <td className="px-4 py-3">{faNumber(p.backtestLimit)}</td>
                <td className="px-4 py-3">{faNumber(p.liveLimit)}</td>
                <td className="px-4 py-3"><Badge tone={p.active ? "success" : "danger"}>{p.active ? "فعال" : "غیرفعال"}</Badge></td>
                <td className="px-4 py-3"><PlanForm plan={p} compact /></td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card>
          <CardTitle>پلن جدید</CardTitle>
          <PlanForm />
        </Card>
      </div>
    </div>
  );
}
