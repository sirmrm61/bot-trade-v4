import { prisma } from "@/infrastructure/database/prisma";
import { DEFAULT_SETTINGS } from "@/shared/constants";

/** System settings — key/value store with defaults. */

export async function getSetting<T = number>(key: keyof typeof DEFAULT_SETTINGS | string): Promise<T> {
  const row = await prisma.systemSetting.findUnique({ where: { key: String(key) } });
  if (row) {
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }
  const def = (DEFAULT_SETTINGS as Record<string, { value: unknown }>)[String(key)];
  return def?.value as T;
}

export async function setSetting(key: string, value: unknown, updatedById?: string, description?: string) {
  return prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(value), updatedById, description },
    update: { value: JSON.stringify(value), updatedById, ...(description ? { description } : {}) },
  });
}

export async function allSettings() {
  const rows = await prisma.systemSetting.findMany({ orderBy: { key: "asc" } });
  const map: Record<string, { value: unknown; description?: string | null; updatedAt: Date }> = {};
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    map[key] = { value: def.value, description: def.description, updatedAt: new Date(0) };
  }
  for (const r of rows) {
    try {
      map[r.key] = { value: JSON.parse(r.value), description: r.description, updatedAt: r.updatedAt };
    } catch {
      map[r.key] = { value: r.value, description: r.description, updatedAt: r.updatedAt };
    }
  }
  return map;
}
