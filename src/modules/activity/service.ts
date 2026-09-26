import { prisma } from "@/infrastructure/database/prisma";

/** Activity / audit log — every meaningful user & system action. */

export async function logActivity(opts: {
  userId?: string | null;
  actorType?: "USER" | "ADMIN" | "SYSTEM" | "WORKER";
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  requestId?: string;
}) {
  return prisma.activityLog.create({
    data: {
      userId: opts.userId ?? null,
      actorType: opts.actorType ?? "USER",
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
      ip: opts.ip,
      requestId: opts.requestId,
    },
  });
}
