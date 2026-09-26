import { describe, it, expect } from "vitest";
import { normalizeOrderBook } from "@/modules/exchanges/nobitex";

describe("normalizeOrderBook", () => {
  it("parses the flat Nobitex /v3/orderbook response", () => {
    const book = normalizeOrderBook(
      {
        status: "ok",
        lastUpdate: 123,
        lastTradePrice: "85896.44",
        bids: [["85896.44", "0.002"], ["85894", "0.004"]],
        asks: [["85900", "0.001"]],
      },
      "BTCUSDT",
    );
    expect(book.bids).toEqual([[85896.44, 0.002], [85894, 0.004]]);
    expect(book.asks).toEqual([[85900, 0.001]]);
  });

  it("also accepts the symbol-keyed shape", () => {
    const book = normalizeOrderBook(
      { BTCIRT: { bids: [["100", "1"]], asks: [["101", "2"]] } },
      "BTCIRT",
    );
    expect(book.bids).toEqual([[100, 1]]);
    expect(book.asks).toEqual([[101, 2]]);
  });

  it("returns empty sides for an empty body", () => {
    const book = normalizeOrderBook({}, "BTCUSDT");
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
  });
});
