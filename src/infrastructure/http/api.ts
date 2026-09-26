import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { verifySessionToken, SESSION_COOKIE } from "@/modules/auth/session";
import { validateSession } from "@/modules/auth/service";
import { AppError, userMessage, httpStatus } from "@/shared/errors";
import { logger } from "@/infrastructure/logging/logger";
import crypto from "node:crypto";

export interface AuthedContext {
  userId: string;
  role: string;
}

type Handler = (req: NextRequest, ctx: AuthedContext & { params?: Record<string, string> }) => Promise<Response | object>;

/** Wrap a route handler: auth + error mapping + request logging. */
export function api(handler: Handler, opts: { admin?: boolean; public?: boolean } = {}) {
  return async (req: NextRequest, routeCtx: { params: Promise<Record<string, string>> }) => {
    const requestId = crypto.randomUUID();
    const start = Date.now();
    try {
      const params = await routeCtx.params;
      const store = await cookies();
      const token = store.get(SESSION_COOKIE)?.value;

      let ctx: AuthedContext = { userId: "", role: "" };
      if (!opts.public) {
        if (!token) throw new AppError("UNAUTHORIZED", 401);
        const payload = await verifySessionToken(token);
        if (!payload) throw new AppError("UNAUTHORIZED", 401);
        const user = await validateSession(token);
        if (!user) throw new AppError("UNAUTHORIZED", 401);
        ctx = { userId: user.id, role: user.role };
        if (opts.admin && user.role !== "ADMIN") throw new AppError("FORBIDDEN", 403);
      }

      const result = await handler(req, { ...ctx, params });
      const res = result instanceof Response ? result : NextResponse.json(result);
      logger.info("api", {
        requestId, module: "api", action: `${req.method} ${new URL(req.url).pathname}`,
        userId: ctx.userId || undefined, duration: Date.now() - start, status: "OK",
      });
      return res;
    } catch (err) {
      const status = httpStatus(err);
      const msg = userMessage(err);
      logger.error("api error", {
        requestId, module: "api", action: `${req.method} ${new URL(req.url).pathname}`,
        duration: Date.now() - start, status: "ERROR",
        errorCode: err instanceof AppError ? err.code : "UNKNOWN",
      });
      return NextResponse.json({ error: msg, code: err instanceof AppError ? err.code : "UNKNOWN", requestId }, { status });
    }
  };
}

export async function body<T>(req: NextRequest): Promise<T> {
  return (await req.json().catch(() => ({}))) as T;
}
