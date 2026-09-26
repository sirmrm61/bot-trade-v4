import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "bt_session";

export interface SessionPayload {
  sub: string; // user id
  role: string; // USER | ADMIN
}

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be at least 32 chars");
  return new TextEncoder().encode(s);
}

export async function createSessionToken(payload: SessionPayload, ttl = "168h"): Promise<string> {
  return new SignJWT({ role: payload.role })
    .setSubject(payload.sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return { sub: payload.sub as string, role: payload.role as string };
  } catch {
    return null;
  }
}

/** Read current session user id/role from cookies (Next.js 16: cookies() is async). */
export async function currentSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function setSessionCookie(token: string, maxAgeSec = 7 * 24 * 3600) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // secure by default in production; set COOKIE_SECURE=false when serving
    // over plain HTTP (e.g. IP-only deploys without TLS) or the browser drops
    // the session cookie and login loops back to /login
    secure: process.env.COOKIE_SECURE
      ? process.env.COOKIE_SECURE === "true"
      : process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSec,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
