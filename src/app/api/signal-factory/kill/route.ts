import { api } from "@/infrastructure/http/api";
import { killSignalFactory } from "@/modules/signal-factory/live";

/** POST /api/signal-factory/kill — emergency stop: cancel every open
 *  signal-factory order on the exchange account, disable the system AND live
 *  trading, write an Incident + journal entry. Open positions stay under the
 *  live-position-manager so monitored stops still fire. */
export const POST = api(async (_req, ctx) => {
  return killSignalFactory(ctx.userId);
});
