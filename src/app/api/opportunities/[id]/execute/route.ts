import { z } from "zod";
import { api, body } from "@/infrastructure/http/api";
import { executeOpportunity } from "@/modules/opportunity/service";

const schema = z.object({
  mode: z.enum(["PAPER", "REAL"]).default("PAPER"),
  allocatedCapital: z.number().positive().max(1e12),
});

/** POST /api/opportunities/:id/execute — trade the opportunity (paper or live). */
export const POST = api(async (req, ctx) => {
  const id = ctx.params?.id;
  if (!id) throw new Error("missing id");
  const input = schema.parse(await body(req));
  const result = await executeOpportunity(ctx.userId, id, input);
  return { ok: true, ...result };
});
