---
name: trading-agent
description: Call the trading platform agent API — pair scanning, market data, strategies, backtests, trades, logs. Use in every review cycle for a trading agent workspace.
---

# Trading Agent API

Everything goes through one endpoint. Auth comes from env vars injected by the
worker (`AGENT_TOKEN`, `AGENT_API_URL`, `AGENT_ID`) — never hardcode them.

## call_action

```bash
call_action() {
  curl -sS -X POST "$AGENT_API_URL/api/agent" \
    -H "Authorization: Bearer $AGENT_TOKEN" \
    -H "X-Agent-Id: $AGENT_ID" \
    -H "Content-Type: application/json" \
    -d "{\"action\": \"$1\", \"params\": $2}"
}
# example:
call_action market_summary '{"symbol":"BTC-USDT"}'
```

Response: `{ "ok": true, "result": ... }` or `{ "error": "...", "detail": "...", "code": "..." }`.
Always check for `error` before using `result`. `detail` carries the math
reason when a risk check rejects a call — read it before retrying.

## Actions

### scan_pairs — discover candidates (AUTO agents)

`{}` → `maxPairs`, currently `managed` symbols, and top-ranked `candidates`
with symbol, marketType, score, volumeUsd24h, spreadPct, volatilityPct,
dayRangePct, change24hPct, alreadyManaged, reasons.

### set_pairs — lock in your pair set

`{"symbols": ["BTC-USDT", "ETH-USDT"]}` → sets managed pairs (max `maxPairs`,
all must exist on your exchange). Pairs you drop are auto-PAUSED.

### market_summary — read per pair every cycle

`{"symbol": "BTC-USDT"}` → price, bid/ask, RSI14, EMA20/50, ATR14, `regime`
(ranging|trending|volatile), `trendPct`, `volPct`, `atrPct`, `liveStatus`.

### performance — 24h progress vs the 5% daily target

`{}` → realized/unrealized PnL across all managed pairs, capital total,
trade counts, `onTarget` flag.

### list_trades — positions you manage

`{}` (all pairs) or `{"symbol": "..."}` → `open`: id, symbol, side,
entryPrice, amount, invested, SL/TP, live `pnlPct`. `closed`: last 15 with
exitPrice, pnlPct, exitReason.

### open_trade — enter a position (max one open per pair)

`{"symbol": "BTC-USDT", "side": "LONG"|"SHORT"}` → creates a trade at market
price using that pair's strategy SL/TP/size config. Fails with `detail` if a
position is already open on that pair.

### close_trade — exit manually

`{"tradeId": "...", "reason": "short explanation"}` → closes at market price.
Use when the entry thesis is invalidated. Reports final PnL.

### list_strategies — the user's existing strategies

`{}` → strategies with kind, symbol, live status, and `managedFor` (which of
your pairs use each). Includes both user-built and AI-created strategies.

### select_strategy — adopt an existing strategy for a pair

`{"symbol": "BTC-USDT", "strategyId": "...", "allocatedCapital": 500}` →
pauses the pair's previous live, starts this strategy in the agent's mode.
The strategy's version symbol must match the pair.

### create_strategy — build a new strategy + go live

`{"symbol": "BTC-USDT", "input": {...StrategyInput}, "allocatedCapital": 500}`
→ creates a strategy (origin "AI"), pauses the pair's previous live, starts it
in the agent's mode, links it to that pair.

StrategyInput (exact field names — do NOT invent other shapes):
```json
{
  "name": "...", "description": "...", "kind": "SIGNAL",
  "symbol": "<fixed to the pair>", "timeframe": "15m",
  "market": "SPOT", "orderType": "MARKET", "leverage": 1,
  "buyThreshold": 0.5, "sellThreshold": -0.5,
  "stopLossPct": 1.5, "takeProfitPct": 3.0,
  "riskPerTradePct": 1, "maxPositionPct": 25,
  "indicators": [
    {
      "name": "RSI", "enabled": true, "weight": 0.6,
      "parameters": {"period": 7},
      "buyCondition": {"op": "lt", "value": 30},
      "sellCondition": {"op": "gt", "value": 70}
    },
    {
      "name": "EMA", "enabled": true, "weight": 0.4,
      "parameters": {"period": 9},
      "buyCondition": {"op": "cross_above", "target": "price"},
      "sellCondition": {"op": "cross_below", "target": "price"}
    }
  ]
}
```
Indicator names: RSI, EMA, SMA, MACD, BOLLINGER, VWAP, STOCHASTIC, OBV, ATR.
Condition ops: lt, lte, gt, gte, eq, between{a,b}, cross_above, cross_below —
`target:"price"` compares the close against the indicator line.
`buyThreshold`/`sellThreshold` are REQUIRED (weighted-score cutoffs, -1..+1).
SIGNAL kind needs ≥1 enabled non-ATR indicator. FUTURES needs `leverage` 1–10.
Kinds: `SIGNAL` (indicator rules), `PRICE_ACTION` (set `priceAction.setup` —
PIN_BAR, ENGULFING, ORDER_BLOCK, FVG, LIQUIDITY_SWEEP, BREAKOUT_RETEST,
RANGE_REVERSION, EMA_PULLBACK …), `GRID`, `ORDER_BOOK_IMBALANCE`,
`MARKET_MAKING`, `ATM_SME`, `RMM_BSE`, `DZS_HMM` (symbolic — leverage ≤ 2).

### update_strategy — tune a pair's strategy

`{"symbol": "BTC-USDT", "patch": {"stopLossPct": 2.0, "takeProfitPct": 4.5}}`
→ merges onto the current config, creates a new version. Small deltas;
justify in state.md.

### backtest — validate a strategy before trusting it

`{"symbol": "BTC-USDT", "days": 30}` (uses the pair's managed strategy) or
`{"strategyId": "...", "days": 30}` → runs a backtest inline and returns
profitPct, winRate, totalTrades, maxDrawdownPct, profitFactor.

### pause_live / resume_live

`{"symbol": "BTC-USDT"}` — pause stops new entries (open trades still
managed by SL/TP). Resume sets the live strategy back to RUNNING.

### log — report to the user panel (call last every cycle)

`{"level": "INFO"|"ACTION"|"DECISION"|"ERROR", "message": "Persian summary"}`
Write 2–4 plain Persian sentences: what you checked, what you decided, why.

## Workflow reminder

Follow `AGENTS.md` — state.md → scan/set pairs if needed → per-pair
market_summary + list_trades → decide → maybe act → performance →
update state.md → `log`. HOLD is a valid decision.
