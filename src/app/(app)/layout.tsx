import { redirect } from "next/navigation";
import { currentSession } from "@/modules/auth/session";
import { AppShell } from "@/components/shell";
import { prisma } from "@/infrastructure/database/prisma";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  if (!session) redirect("/login");
  const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { role: true } });
  if (!user) redirect("/login");
  return <AppShell role={user.role}>{children}</AppShell>;
}
