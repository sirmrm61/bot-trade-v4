# Backtest / Scanner / Strategy — Trace & Debugging Architecture

> Internal architecture doc — describes the data flow before and after the
> trace system. Written before instrumenting; updated to reflect the final
> implementation.

## 1. Current data flow (pre-trace)

```
Candles (DB / exchange)
  → runBacktest(params)            [src/modules/backtest/engine.ts]
      for i = warmup..len:
        equity mark-to-market
        if openPosition: SL → TP → trailing → signal-exit  (checked on candle H/L)
        else: signal = evalSignal(i) → entry at candles[i+delay].open ± slippage
      closePosition(): fee on exit notional, pnl → SimTrade[]
  → summarizeResult()              [same file]
      win rate / drawdown / profit factor / duration
  → runAndPersist()                [src/modules/backtest/service.ts]
      persist Backtest row + BacktestTrade rows
```

- **Signal creation point**: `evalSignal(i)` → `computeSignal()` (indicator
  engine) or a custom `signalFn` (OBI proxy, smart symbolic wrappers).
- **Entry point**: candle `i + delayCandles`, fill at that candle's **open**
  ± slippage. `executionDelayMs=0` → same-bar open.
- **Exit point**: per-candle check order: liquidation → SL (low/high touch) →
  TP → trailing → opposite-signal → end-of-data.
- **TP/SL**: fixed `%` of fill price, or ATR-multiples when `atrStops` set.
- **Costs**: entry fee reduces acquired amount (`amount = (invested − fee) /
  fill`); exit fee deducted from proceeds; slippage applied to both fills.
- **PnL**: spot `pnl = proceeds − exitFee − invested`; futures `pnl =
  dirΔ·amount − exitFee`, margin returned.
- **Portfolio**: single running `balance`; `riskPerTradePct` of equity per
  trade, capped at balance.

## 2. Known weaknesses found during review

| # | Issue | Where | Severity |
|---|-------|-------|----------|
| 1 | **Look-ahead**: `executionDelayMs=0` enters at `open` of the *signal bar*, while the signal is computed using that bar's `close`. Fill price is chronologically *before* the data that produced the signal. | engine.ts `execIdx = i + delayCandles`, `execCandle.open` | HIGH when delay=0 |
| 2 | **TP/SL same-candle ambiguity**: when a candle's range touches both SL and TP, SL wins (silently conservative). No report of ambiguity. | engine.ts position-mgmt branch | MEDIUM (conservative but invisible) |
| 3 | **No spread model**: backtest slippage is a flat %; no bid/ask spread cost. Live execution crosses real spread. | engine.ts | MEDIUM |
| 4 | **Scanner → backtest divergence**: `scanOpportunities` computes live-book costs (spread/depth/slippage) while `backtestScanner` uses flat fee+slippage on candles — different cost models by design, now traced explicitly. | opportunity/engine.ts | LOW (documented) |
| 5 | **Rejected candidates invisible**: `computeOpportunity` returned `null` on reject — no record of *why*. | opportunity/engine.ts | observability gap |
| 6 | **Per-bar decisions invisible**: HOLD bars, signal flips, balance gates — none persisted. | engine.ts | observability gap |

## 3. Trace design (implemented)

### IDs — deterministic

```
backtestRunId      = "bt-" + backtest.id
opportunityTraceId = "opp-" + runId + "-" + symbol + "-" + barTs
tradeTraceId       = "tr-"  + runId + "-" + seq
scanRunId          = "scan-" + iso timestamp
```

Deterministic: same inputs → same ids (seq = trade index in run).

### Chain

```
Backtest Run (runId)
  └─ Candidate   (candidateId — one per evaluated bar/symbol)
       └─ Signal  (score, breakdown, threshold checks)
            └─ Cost    (estimated: fee, slippage, spread, expected P/L)
                 └─ Entry   (signalPrice → requested → executed, executionModel)
                      └─ Position (per-candle TP/SL checks — FULL only)
                           └─ Exit (reason, fills, cost breakdown)
                                └─ PnL Audit (recomputed vs recorded)
```

Rejected candidates end at the stage that killed them, carrying
`rejectionStage` + `primaryRejectReason` + all failed filters.

### Stages

`SCANNER → STRATEGY → COST → RISK → EXECUTION(ENTRY) → POSITION → EXIT → PNL_AUDIT → SUMMARY`

### Levels

| Level | Content |
|-------|---------|
| `OFF` | nothing (default — zero overhead) |
| `SUMMARY` | trades (entry/exit/pnl/audit) + rejected-by-stage counters + summary |
| `FULL` | everything in SUMMARY + per-candle market snapshot, signal evals, position checks |

Scope filters: `traceSymbol`, `traceFrom`/`traceTo` (candle time), `tradeTraceId`.

### Look-ahead guard

`strictCausality: true` → entry is forced to **next bar open** when the signal
came from the current bar's close (min delay = 1 candle); emits
`LOOKAHEAD_ENFORCED`. With default settings, entering on the signal bar's open
emits `LOOKAHEAD_BIAS` warning (severity HIGH).

### TP/SL ambiguity

`ambiguityPolicy`: `SL_FIRST` (default, matches legacy), `TP_FIRST`,
`CONSERVATIVE` (= SL_FIRST longs / TP… actually worst-case per side),
`REPORT` (resolve by legacy order but emit `AMBIGUOUS_EXIT`).

### Storage

- `TraceEvent` table — keyed by `runId`, indexed; `refId` links events of one
  candidate/trade. JSON payload. Pruned by event cap (default 50k).
- `BacktestTrade.trace` (JSON) — self-contained per-trade chain → `traceTrade()`.
- `Backtest.results.trace` — summary block (counters, rejection aggregation).

### Replay

`replayTrade(tradeTraceId)` → re-simulates the stored candle window with the
recorded params → compares entry/exit/pnl → `REPLAY_MATCH` or `REPLAY_MISMATCH`
with diffs. Deterministic because inputs (candles, params) are immutable.

### APIs

- `GET /api/backtests/[id]/trace` — full event log (JSON) `?format=csv` → CSV
- `GET /api/trace/[tradeTraceId]` — one trade's full chain
- `POST /api/trace/[tradeTraceId]/replay` — deterministic replay + diff
- `POST /api/backtests` accepts `traceLevel`, `traceSymbol`

### Viewer

`/backtests/[id]/trace` — tree: Run → Trades → per-trade timeline
(market → scanner → strategy → cost → entry → position → exit → pnl),
rejection aggregation table.
