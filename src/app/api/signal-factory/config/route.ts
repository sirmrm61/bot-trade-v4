import { api, body } from "@/infrastructure/http/api";
import { getOrCreateConfig, updateConfig, type SignalConfigInput } from "@/modules/signal-factory/config";

export const GET = api(async (_req, ctx) => {
  return { config: await getOrCreateConfig(ctx.userId) };
});

export const POST = api(async (req, ctx) => {
  const input = await body<Record<string, unknown>>(req);
  // ApiForm serializes each named control — timeframe checkboxes arrive as
  // `tf:4h`-style keys; collect the checked ones into `timeframes`.
  const timeframes = Object.keys(input)
    .filter((k) => k.startsWith("tf:") && input[k] === true)
    .map((k) => k.slice(3));
  const { exchange, marketType, quote, minVolume24h, scanEveryHours, enabled, liveTradingEnabled } =
    input as SignalConfigInput;
  const config = await updateConfig(ctx.userId, {
    exchange, marketType, quote, minVolume24h, scanEveryHours, enabled, liveTradingEnabled,
    timeframes: timeframes.length ? timeframes : undefined,
  });
  return { config };
});
