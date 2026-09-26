import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { loginUser } from "@/modules/auth/service";
import { setSessionCookie } from "@/modules/auth/session";
import { AppError } from "@/shared/errors";

const schema = z.object({
  identifier: z.string().min(1),
  password: z.string().min(1),
});

export const POST = api(async (req) => {
  const parsed = schema.safeParse(await body(req));
  if (!parsed.success) throw new AppError("VALIDATION", 400);
  const ip = req.headers.get("x-forwarded-for") ?? undefined;
  const { user, token } = await loginUser({
    identifier: parsed.data.identifier,
    password: parsed.data.password,
    ip,
    userAgent: req.headers.get("user-agent") ?? undefined,
  });
  await setSessionCookie(token);
  return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
}, { public: true });
