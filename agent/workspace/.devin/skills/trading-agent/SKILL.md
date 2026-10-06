---
name: trading-agent
description: Call the trading platform agent API — market data, strategies, trades, logs. Use in every review cycle for a trading agent workspace.
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
call_action market_summary '{}'
```

Response: `{ "ok": true, "result": ... }` or `{ "error": "...", "detail": "...", "code": "..." }`.
Always check for `error` before using `result`. `detail` carries the math
reason when a risk check rejects a call — read it before retrying.

## Actions

### market_summary — read first every cycle

`{}` → symbol, price, bid/ask, RSI14, EMA20/50, ATR14, `regime`
(ranging|trending|volatile), `trendPct`, `volPct`, `atrPct`, `liveStatus`.

### list_trades — positions you manage

`{}` → `open`: id, side, entryPrice, amount, invested, SL/TP, live `pnlPct`.
`closed`: last 10 with exitPrice, pnlPct, exitReason.

### open_trade — enter a position (max one open)

`{"side": "LONG"|"SHORT"}` → creates a trade at market price using the managed
strategy's SL/TP/size config. Fails with `detail` if a position is already open.

### close_trade — exit manually

`{"tradeId": "...", "reason": "short explanation"}` → closes at market price.
Use when the entry thesis is invalidated. Reports final PnL.

### list_strategies — adopt or create

`{}` → user's strategies with kind, symbol, live status, and a `managed` flag.

### create_strategy — build a new strategy + go live

`{"input": {...StrategyInput}, "allocatedCapital": 500}` → creates a strategy
(with origin "AI"), starts it in the agent's mode, links it to this agent.

StrategyInput (exact field names — do NOT invent other shapes):
```json
{
  "name": "...", "description": "...", "kind": "SIGNAL",
  "symbol": "<fixed to your symbol>", "timeframe": "15m",
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

### update_strategy — tune the managed strategy

`{"patch": {"stopLossPct": 2.0, "takeProfitPct": 4.5}}` → merges onto the
current config, creates a new version. Small deltas; justify in state.md.

### pause_live / resume_live

`{}` — pause stops new entries (open trades still managed by SL/TP).
Resume sets the live strategy back to RUNNING.

### log — report to the user panel (call last every cycle)

`{"level": "INFO"|"ACTION"|"DECISION"|"ERROR", "message": "Persian summary"}`
Write 2–4 plain Persian sentences: what you checked, what you decided, why.

## Workflow reminder

Follow `AGENTS.md` — state.md → market_summary → list_trades → decide →
maybe act → update state.md → `log`. HOLD is a valid decision.
