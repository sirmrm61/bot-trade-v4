import "dotenv/config";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { DEFAULT_SETTINGS } from "../src/shared/constants";

const url = (process.env.DATABASE_URL ?? "file:./dev.db").replace(/^file:/, "");
const file = path.isAbsolute(url) ? url : path.join(process.cwd(), url);
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: file }) });

async function main() {
  // ---- plans -------------------------------------------------------------
  const plans = [
    { slug: "free", name: "رایگان", durationDays: 7, price: 0, backtestLimit: 1, liveLimit: 1, sortOrder: 0, isDefault: true, description: "پلن رایگان آشنایی" },
    { slug: "basic-7", name: "پایه ۷ روزه", durationDays: 7, price: 1000, backtestLimit: 3, liveLimit: 3, sortOrder: 1 },
    { slug: "basic-15", name: "پایه ۱۵ روزه", durationDays: 15, price: 2000, backtestLimit: 3, liveLimit: 3, sortOrder: 2 },
    { slug: "basic-30", name: "پایه ۳۰ روزه", durationDays: 30, price: 2000, backtestLimit: 3, liveLimit: 3, sortOrder: 3 },
    { slug: "pro-7", name: "حرفه‌ای ۷ روزه", durationDays: 7, price: 2000, backtestLimit: 5, liveLimit: 5, sortOrder: 4 },
    { slug: "pro-15", name: "حرفه‌ای ۱۵ روزه", durationDays: 15, price: 3000, backtestLimit: 5, liveLimit: 5, sortOrder: 5 },
    { slug: "enterprise", name: "سازمانی", durationDays: 30, price: 0, backtestLimit: 100, liveLimit: 50, sortOrder: 6, description: "تماس با فروش" },
  ];
  for (const p of plans) {
    await prisma.plan.upsert({ where: { slug: p.slug }, create: p, update: p });
  }

  // ---- admin -------------------------------------------------------------
  const adminUser = process.env.ADMIN_USERNAME ?? "admin";
  const adminPass = process.env.ADMIN_PASSWORD ?? "admin123";
  const existing = await prisma.user.findUnique({ where: { username: adminUser } });
  if (!existing) {
    const admin = await prisma.user.create({
      data: {
        username: adminUser,
        email: process.env.ADMIN_EMAIL ?? "admin@example.com",
        passwordHash: await bcrypt.hash(adminPass, 12),
        role: "ADMIN",
        referralCode: `ADMIN-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
      },
    });
    await prisma.wallet.create({ data: { userId: admin.id } });
    console.log("admin created:", adminUser);
  }

  // ---- system settings ----------------------------------------------------
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(def.value), description: def.description },
      update: {},
    });
  }

  console.log("seed complete");
}

main().finally(() => prisma.$disconnect());
