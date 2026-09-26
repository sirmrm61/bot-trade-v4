import { api } from "@/infrastructure/http/api";
import { logoutUser } from "@/modules/auth/service";
import { clearSessionCookie, SESSION_COOKIE } from "@/modules/auth/session";
import { cookies } from "next/headers";

export const POST = api(async (_req, ctx) => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await logoutUser(token, ctx.userId);
  await clearSessionCookie();
  return { ok: true };
});
