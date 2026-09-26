// Public BingX market data (USDT-margined perpetual swaps), shaped like the OKX feed the engine was built on.
// Quantities are in coins (ctVal = 1): a "contract" here is one coin, rounded to the symbol's quantity step.
import type { Kind } from "../market/kinds.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";
import type { PublicApi } from "../okx/public.js";
import { createBingxClient, type BingxClient } from "./client.js";

type Row = Record<string, string | number | boolean>;
const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));
const INTERVAL = { "15m": ["15m", 15 * 60_000], "1H": ["1h", 3_600_000], "4H": ["4h", 4 * 3_600_000] } as const;
export const BINGX_TTL_MS = { tickers: 900, candles: 10_000, instruments: 10_000, openInterest: 5_000, funding: 10_000 } as const;

/** BingX tags tokenised stocks, commodities, FX and indices with an NC** prefix (NCSKAAPL2USD, NCCOGOLD2USD, ...). */
export function bingxKind(asset: string): Kind {
  if (asset.startsWith("TEST")) return "test";
  if (asset.startsWith("NCCO")) return "commodity";
  if (/^NC(SK|FX|SI)/.test(asset)) return "stock";
  return "crypto";
}

export function parseContract(r: Row): Instrument {
  const coin = String(r.asset);
  const step = Number((10 ** -num(r.quantityPrecision)).toPrecision(1));
  return {
    instId: String(r.symbol),
    coin,
    kind: bingxKind(coin),
    ctVal: 1,
    lotSz: step,
    minSz: Math.max(step, num(r.tradeMinQuantity) || 0),
    tickSz: Number((10 ** -num(r.pricePrecision)).toPrecision(1)),
    state: Number(r.status) === 1 && String(r.apiStateOpen) === "true" ? "live" : "suspend",
  };
}

export function parseBingxTicker(r: Row, now: number): Ticker {
  const last = num(r.lastPrice);
  const bid = num(r.bidPrice);
  const ask = num(r.askPrice);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  return {
    instId: String(r.symbol),
    last,
    bid,
    ask,
    mid,
    spreadBp: bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : Infinity,
    vol24hUsd: num(r.quoteVolume),
    open24h: num(r.openPrice),
    ts: num(r.closeTime) || now,
  };
}

/** BingX sends newest first; a bar is confirmed once its interval has fully passed. */
export function parseBingxCandles(rows: Row[], intervalMs: number, now: number): Candle[] {
  return rows
    .map((r) => {
      const ts = num(r.time);
      const c = num(r.close);
      return { ts, o: num(r.open), h: num(r.high), l: num(r.low), c, volUsd: num(r.volume) * c, confirmed: ts + intervalMs <= now };
    })
    .sort((a, b) => a.ts - b.ts);
}

export function createBingxPublicApi(apiBase: string, client: BingxClient = createBingxClient({ apiBase, timeoutMs: 15_000 }), now: () => number = Date.now): PublicApi {
  return {
    async instruments() {
      const rows = await client.get<Row[]>("/openApi/swap/v2/quote/contracts", {}, BINGX_TTL_MS.instruments);
      return rows.filter((r) => String(r.symbol).endsWith("-USDT")).map(parseContract);
    },
    async tickers() {
      const rows = await client.get<Row[]>("/openApi/swap/v2/quote/ticker", {}, BINGX_TTL_MS.tickers);
      const out = new Map<string, Ticker>();
      for (const r of rows) if (String(r.symbol).endsWith("-USDT")) out.set(String(r.symbol), parseBingxTicker(r, now()));
      return out;
    },
    async candles(instId, bar, limit) {
      const [interval, ms] = INTERVAL[bar];
      const rows = await client.get<Row[]>("/openApi/swap/v3/quote/klines", { symbol: instId, interval, limit }, BINGX_TTL_MS.candles);
      return parseBingxCandles(rows, ms, now());
    },
    async openInterest(instIds: string[] = []) {
      // BingX only answers one symbol at a time, so the feed asks just for the coins it tracks.
      const out = new Map<string, number>();
      await Promise.all(
        instIds.map(async (symbol) => {
          const r = await client.get<Row>("/openApi/swap/v2/quote/openInterest", { symbol }, BINGX_TTL_MS.openInterest).catch(() => null);
          if (r && Number.isFinite(num(r.openInterest))) out.set(symbol, num(r.openInterest));
        }),
      );
      return out;
    },
    async funding(instId): Promise<FundingNow> {
      const r = await client.get<Row>("/openApi/swap/v2/quote/premiumIndex", { symbol: instId }, BINGX_TTL_MS.funding);
      return { rate: num(r?.lastFundingRate), nextFundingTime: num(r?.nextFundingTime) };
    },
    async fundingHistory(instId, limit) {
      const rows = await client.get<Row[]>("/openApi/swap/v2/quote/fundingRate", { symbol: instId, limit }, BINGX_TTL_MS.funding);
      return rows.map((r) => num(r.fundingRate)).filter(Number.isFinite);
    },
  };
}

/** Setup's coin picker: crypto USDT perps that are open for API trading on BingX right now. */
export async function fetchBingxCoins(apiBase: string, timeoutMs = 10_000): Promise<string[]> {
  const client = createBingxClient({ apiBase, timeoutMs });
  const rows = await client.get<Row[]>("/openApi/swap/v2/quote/contracts");
  const coins = rows
    .filter((r) => String(r.symbol).endsWith("-USDT"))
    .map(parseContract)
    .filter((i) => i.state === "live" && i.kind === "crypto")
    .map((i) => i.coin);
  return [...new Set(coins)].sort();
}
