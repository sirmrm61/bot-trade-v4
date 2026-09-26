import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/modules/auth/session";

/**
 * Next.js 16 "proxy" (formerly middleware) — redirects unauthenticated
 * users away from the app shell. Node.js runtime only.
 */
const PROTECTED = ["/dashboard", "/account", "/wallet", "/strategies", "/backtests", "/live", "/trades", "/marketplace", "/purchases", "/referrals", "/notifications", "/plans", "/admin", "/help"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const needsAuth = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!needsAuth) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
