import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { registerUser, loginUser } from "@/modules/auth/service";
import { setSessionCookie } from "@/modules/auth/session";

const schema = z.object({
  username: z.string().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email().optional().or(z.literal("")),
  mobile: z.string().optional(),
  password: z.string().min(8),
  referralCode: z.string().optional(),
});

export const POST = api(async (req) => {
  const input = schema.parse(await body(req));
  const ip = req.headers.get("x-forwarded-for") ?? undefined;
  await registerUser({
    username: input.username,
    email: input.email || undefined,
    mobile: input.mobile,
    password: input.password,
    referralCode: input.referralCode,
    ip,
  });
  // auto-login after register
  const { token, user } = await loginUser({ identifier: input.username, password: input.password, ip });
  await setSessionCookie(token);
  return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
}, { public: true });
