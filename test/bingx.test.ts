import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createBingxClient, queryString, sign } from "../src/bingx/client.js";
import { BingxExecutor } from "../src/bingx/executor.js";
import { bingxKind, createBingxPublicApi, parseBingxCandles, parseBingxTicker, parseContract } from "../src/bingx/public.js";

const BTC = { symbol: "BTC-USDT", asset: "BTC", quantityPrecision: 4, pricePrecision: 1, tradeMinQuantity: 0.0001, status: 1, apiStateOpen: "true" };

/** A fake fetch that answers by path and records every URL it saw. */
function fakeFetch(routes: Record<string, unknown>) {
  const seen: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];
  const f = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string> });
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    const data = routes[key];
    if (data === undefined) return new Response(JSON.stringify({ code: 100400, msg: `no route ${key}` }), { status: 200 });
    return new Response(JSON.stringify({ code: 0, msg: "", data: typeof data === "function" ? data(url) : data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

describe("bingx public data", () => {
  it("maps a contract to an instrument in coins", () => {
    expect(parseContract(BTC)).toEqual({ instId: "BTC-USDT", coin: "BTC", kind: "crypto", ctVal: 1, lotSz: 0.0001, minSz: 0.0001, tickSz: 0.1, state: "live" });
    expect(parseContract({ ...BTC, apiStateOpen: "false" }).state).not.toBe("live");
    expect(parseContract({ ...BTC, status: 25 }).state).not.toBe("live");
  });

  it("tags BingX's tokenised stocks, commodities and FX as non-crypto", () => {
    expect(bingxKind("NCSKAAPL2USD")).toBe("stock");
    expect(bingxKind("NCFXEUR2USD")).toBe("stock");
    expect(bingxKind("NCCOGOLD2USD")).toBe("commodity");
    expect(bingxKind("PEPE")).toBe("crypto");
  });

  it("tickers carry USD volume and the spread in bp", () => {
    const t = parseBingxTicker({ symbol: "BTC-USDT", lastPrice: "100", bidPrice: "99.99", askPrice: "100.01", quoteVolume: "5000000", openPrice: "98", closeTime: 1 }, 0);
    expect(t.vol24hUsd).toBe(5_000_000);
    expect(t.spreadBp).toBeCloseTo(2, 6);
  });

  it("candles come back oldest first, the open bar unconfirmed", () => {
    const now = 3_600_000 * 10 + 60_000;
    const rows = [
      { time: 3_600_000 * 10, open: "2", high: "3", low: "1", close: "2", volume: "5" },
      { time: 3_600_000 * 9, open: "1", high: "2", low: "1", close: "2", volume: "4" },
    ];
    const c = parseBingxCandles(rows, 3_600_000, now);
    expect(c.map((x) => x.ts)).toEqual([3_600_000 * 9, 3_600_000 * 10]);
    expect(c.map((x) => x.confirmed)).toEqual([true, false]);
    expect(c[0]!.volUsd).toBe(8);
  });

  it("keeps only USDT perps and asks open interest per symbol", async () => {
    const { f, seen } = fakeFetch({
      "GET /openApi/swap/v2/quote/contracts": [BTC, { ...BTC, symbol: "BTC-USDC" }],
      "GET /openApi/swap/v2/quote/openInterest": (u: URL) => ({ symbol: u.searchParams.get("symbol"), openInterest: "123" }),
    });
    const api = createBingxPublicApi("https://x.test", createBingxClient({ apiBase: "https://x.test", timeoutMs: 1000, fetch: f }));
    expect((await api.instruments()).map((i) => i.instId)).toEqual(["BTC-USDT"]);
    expect([...(await api.openInterest(["BTC-USDT", "ETH-USDT"])).entries()]).toEqual([
      ["BTC-USDT", 123],
      ["ETH-USDT", 123],
    ]);
    expect(seen.filter((s) => s.url.pathname.endsWith("openInterest"))).toHaveLength(2);
  });
});

describe("bingx signing", () => {
  it("signs the exact query string with HMAC-SHA256 and sends the key only as a header", async () => {
    const { f, seen } = fakeFetch({ "GET /openApi/swap/v2/user/positions": [] });
    const c = createBingxClient({ apiBase: "https://x.test", timeoutMs: 1000, fetch: f, now: () => 1700000000000 });
    await c.signed("GET", "/openApi/swap/v2/user/positions", { apiKey: "KEY", secretKey: "SECRET" }, { symbol: "BTC-USDT" });
    const { url, headers } = seen[0]!;
    const qs = "symbol=BTC-USDT&timestamp=1700000000000";
    expect(queryString({ symbol: "BTC-USDT", timestamp: 1700000000000 })).toBe(qs);
    expect(url.searchParams.get("signature")).toBe(createHmac("sha256", "SECRET").update(qs).digest("hex"));
    expect(sign("SECRET", qs)).toBe(url.searchParams.get("signature"));
    expect(headers["X-BX-APIKEY"]).toBe("KEY");
    expect(url.toString()).not.toContain("SECRET");
  });
});

describe("bingx executor", () => {
  const inst = parseContract(BTC);

  it("places a one-way market order and reads the fill", async () => {
    const { f, seen } = fakeFetch({
      "POST /openApi/swap/v2/trade/marginType": {},
      "POST /openApi/swap/v2/trade/leverage": {},
      "POST /openApi/swap/v2/trade/order": { order: { orderId: 7 } },
      "GET /openApi/swap/v2/trade/order": { order: { orderId: 7, status: "FILLED", executedQty: "0.0012", avgPrice: "84000", commission: "-0.0504", updateTime: 5 } },
    });
    const ex = new BingxExecutor(createBingxClient({ apiBase: "https://x.test", timeoutMs: 1000, fetch: f }), { bee1: { apiKey: "K", secretKey: "S" } }, () => inst, 2);
    const r = await ex.market("bee1", { instId: "BTC-USDT", side: "buy", contracts: 0.0012, reduceOnly: false, clOrdId: "be1abc" });
    expect(r).toEqual({ ok: true, ordId: "7", contracts: 0.0012, avgPx: 84000, feeUsd: 0.0504, ts: 5 });
    const order = seen.find((s) => s.method === "POST" && s.url.pathname.endsWith("/trade/order"))!.url.searchParams;
    expect(Object.fromEntries(["symbol", "side", "positionSide", "type", "quantity", "clientOrderID"].map((k) => [k, order.get(k)]))).toEqual({
      symbol: "BTC-USDT",
      side: "BUY",
      positionSide: "BOTH",
      type: "MARKET",
      quantity: "0.0012",
      clientOrderID: "be1abc",
    });
    expect(order.has("reduceOnly")).toBe(false);
    expect(seen.find((s) => s.url.pathname.endsWith("/leverage"))!.url.searchParams.get("leverage")).toBe("2");
  });

  it("a BingX refusal is 'rejected'; positions are signed by side", async () => {
    const { f } = fakeFetch({
      "GET /openApi/swap/v2/user/positions": [
        { symbol: "BTC-USDT", positionSide: "SHORT", positionAmt: "0.5", avgPrice: "80000" },
        { symbol: "ETH-USDT", positionSide: "BOTH", positionAmt: "0", avgPrice: "0" },
      ],
    });
    const ex = new BingxExecutor(createBingxClient({ apiBase: "https://x.test", timeoutMs: 1000, fetch: f }), { bee1: { apiKey: "K", secretKey: "S" } }, () => inst, 2);
    const r = await ex.market("bee1", { instId: "BTC-USDT", side: "sell", contracts: 0.5, reduceOnly: true, clOrdId: "x" });
    expect(r).toMatchObject({ ok: false, state: "rejected" });
    expect(await ex.positions("bee1")).toEqual([{ instId: "BTC-USDT", pos: -0.5, avgPx: 80000 }]);
  });
});
