import { currentSession } from "@/modules/auth/session";
import { prisma } from "@/infrastructure/database/prisma";
import { getOrCreateConfig, configTimeframes } from "@/modules/signal-factory/config";
import { marketContext } from "@/modules/signal-factory/context";
import { lastScanAt } from "@/modules/signal-factory/setups";
import { dataFresh } from "@/modules/signal-factory/data";
import { parseJson } from "@/shared/utils";
import { PageHeader } from "@/components/ui";
import { TopSetupsPanel, type SetupRow, type ContextRow } from "./panel";

const ACTIVE_STATES = ["PROPOSED", "BACKTESTED", "WAITING_TRIGGER", "PAPER_OPEN"];

export default async function TopSetupsPage() {
  const session = await currentSession();
  const cfg = await getOrCreateConfig(session!.sub);

  const [setups, lastScan] = await Promise.all([
    prisma.setup.findMany({
      where: { userId: session!.sub, state: { in: ACTIVE_STATES } },
      orderBy: { score: "desc" },
      take: 10,
    }),
    lastScanAt(session!.sub),
  ]);

  let context: ContextRow | null = null;
  try {
    const c = await marketContext({ ...cfg, timeframe: configTimeframes(cfg)[0] });
    const { refCandles: _drop, ...rest } = c;
    context = rest;
  } catch {
    context = null;
  }

  const rows: SetupRow[] = setups.map((s) => ({
    id: s.id,
    symbol: s.symbol,
    direction: s.direction,
    kind: s.kind,
    timeframe: s.timeframe,
    triggerPrice: s.triggerPrice,
    confirmRule: s.confirmRule,
    entryLow: s.entryLow,
    entryHigh: s.entryHigh,
    tp1: s.tp1,
    tp2: s.tp2,
    sl: s.sl,
    rr: s.rr,
    score: s.score,
    confidence: s.confidence,
    reasonFa: s.reasonFa,
    levelsMeta: parseJson<Record<string, string>>(s.levelsMeta, {}),
    executable: s.executable,
    state: s.state,
    backtestLabel: s.backtestLabel,
    expiresAt: s.expiresAt.toISOString(),
    priceAtScan: s.priceAtScan,
  }));

  const stale = !lastScan || Date.now() - Number(lastScan) > 2 * cfg.scanEveryHours * 3_600_000;

  return (
    <div>
      <PageHeader
        title="ستاپ‌های برتر"
        description="سطح‌محور و شرطی — ورود فقط بعد از تأیید تریگر، نه ورود فوری"
      />
      <TopSetupsPanel
        context={context}
        setups={rows}
        lastScanAt={Number(lastScan) || null}
        stale={stale}
        dataFresh={dataFresh(cfg.exchange)}
        marketType={cfg.marketType}
        timeframe={configTimeframes(cfg)[0]}
      />
    </div>
  );
}
