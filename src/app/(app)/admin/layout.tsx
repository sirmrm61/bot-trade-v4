import { redirect } from "next/navigation";
import { currentSession } from "@/modules/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session || session.role !== "ADMIN") redirect("/dashboard");
  return <>{children}</>;
}
