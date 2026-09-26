// MODE=demo / live on BingX: market orders on USDT-margined perpetual swaps, signed per bee.
// One-way position mode (positionSide BOTH), isolated margin, MAX_LEVERAGE, reduceOnly on every close.
// Demo = BingX VST (open-api-vst.bingx.com): the same API keys, fake USDT.
import type { BeeId } from "../config.js";
import type { ExchangePosition, Executor, FundingBill, OrderReq, OrderResult } from "../exec/executor.js";
import { formatSz } from "../exec/sizing.js";
import { log } from "../log.js";
import type { Instrument } from "../market/types.js";
import { safeError } from "../redact.js";
import { BingxError, type BingxClient, type BingxCreds } from "./client.js";

type Row = Record<string, string | number | boolean | null>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BingxExecutor implements Executor {
  readonly kind = "bingx" as const;
  private leverageSet = new Set<string>();

  constructor(
    private client: BingxClient,
    private creds: Partial<Record<BeeId, BingxCreds>>,
    private instrument: (instId: string) => Instrument | undefined,
    private leverage: number,
  ) {}

  private call<T>(bee: BeeId, method: "GET" | "POST", path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const c = this.creds[bee];
    if (!c) throw new Error(`no BingX credentials for ${bee}`);
    return this.client.signed<T>(method, path, c, params);
  }

  async init(bee: BeeId): Promise<void> {
    try {
      const r = await this.call<Row>(bee, "GET", "/openApi/swap/v1/positionSide/dual");
      if (String(r?.dualSidePosition) === "true") {
        log.info("setting one-way position mode", { bee });
        await this.call(bee, "POST", "/openApi/swap/v1/positionSide/dual", { dualSidePosition: "false" });
      }
    } catch (err) {
      // Fails while positions are open; hedge mode would break reduceOnly closes, so say so loudly.
      log.warn("could not confirm one-way position mode; set it on BingX by hand", { bee, err: safeError(err) });
    }
  }

  private async ensureLeverage(bee: BeeId, symbol: string): Promise<void> {
    const key = `${bee}:${symbol}`;
    if (this.leverageSet.has(key)) return;
    await this.call(bee, "POST", "/openApi/swap/v2/trade/marginType", { symbol, marginType: "ISOLATED" }).catch((err) =>
      log.debug("marginType unchanged", { symbol, err: safeError(err) }),
    );
    await this.call(bee, "POST", "/openApi/swap/v2/trade/leverage", { symbol, side: "BOTH", leverage: this.leverage });
    this.leverageSet.add(key);
  }

  async market(bee: BeeId, req: OrderReq): Promise<OrderResult> {
    const inst = this.instrument(req.instId);
    if (!inst) return { ok: false, error: { code: "INST", message: "unknown instrument" }, state: "rejected" };
    try {
      if (!req.reduceOnly) await this.ensureLeverage(bee, req.instId);
      await this.call(bee, "POST", "/openApi/swap/v2/trade/order", {
        symbol: req.instId,
        side: req.side === "buy" ? "BUY" : "SELL",
        positionSide: "BOTH",
        type: "MARKET",
        quantity: formatSz(req.contracts, inst),
        reduceOnly: req.reduceOnly ? "true" : undefined,
        clientOrderID: req.clOrdId,
      });
    } catch (err) {
      // A BingX error code means it refused the order; a timeout or network error may still have placed it.
      return { ok: false, error: safeError(err), state: err instanceof BingxError ? "rejected" : "unknown" };
    }
    // Market orders fill at once; poll for the fill. A read error here must not end the poll: the order is placed.
    for (let i = 0; i < 12; i++) {
      let o: Row | undefined;
      try {
        o = (await this.call<{ order?: Row }>(bee, "GET", "/openApi/swap/v2/trade/order", { symbol: req.instId, clientOrderId: req.clOrdId }))?.order;
      } catch (err) {
        log.warn("fill poll failed, retrying", { bee, err: safeError(err) });
        await sleep(Math.min(4000, 400 * 2 ** Math.min(i, 3)));
        continue;
      }
      const filled = Number(o?.executedQty ?? 0);
      if (o && (o.status === "FILLED" || ((o.status === "CANCELED" || o.status === "EXPIRED") && filled > 0))) {
        return { ok: true, ordId: o.orderId != null ? String(o.orderId) : null, contracts: filled, avgPx: Number(o.avgPrice), feeUsd: Math.abs(Number(o.commission || 0)), ts: Number(o.updateTime || o.time || Date.now()) };
      }
      if (o && (o.status === "CANCELED" || o.status === "EXPIRED" || o.status === "FAILED")) return { ok: false, error: { code: String(o.status), message: "order ended unfilled" }, state: "rejected" };
      await sleep(300);
    }
    return { ok: false, error: { code: "UNCONFIRMED", message: "fill not confirmed; reconciliation will settle it" }, state: "unknown" };
  }

  async positions(bee: BeeId): Promise<ExchangePosition[] | null> {
    try {
      const rows = await this.call<Row[]>(bee, "GET", "/openApi/swap/v2/user/positions");
      return rows
        .map((r) => {
          const amt = Number(r.positionAmt);
          const pos = r.positionSide === "SHORT" ? -Math.abs(amt) : r.positionSide === "LONG" ? Math.abs(amt) : amt;
          return { instId: String(r.symbol), pos, avgPx: Number(r.avgPrice) };
        })
        .filter((p) => p.pos !== 0);
    } catch (err) {
      log.warn("positions read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async fundingBills(bee: BeeId): Promise<FundingBill[] | null> {
    try {
      const rows = await this.call<Row[]>(bee, "GET", "/openApi/swap/v2/user/income", { incomeType: "FUNDING_FEE", limit: 100 });
      return (rows ?? []).map((r) => ({
        billId: String(r.tranId ?? r.tradeId ?? `${r.symbol}-${r.time}`),
        instId: r.symbol ? String(r.symbol) : null,
        amountUsd: Number(r.income),
        ts: Number(r.time),
      }));
    } catch (err) {
      log.warn("income read failed", { bee, err: safeError(err) });
      return null;
    }
  }

  async feesFor(bee: BeeId, instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    try {
      const out = new Map<string, number>();
      for (const symbol of instIds) {
        const r = await this.call<{ orders?: Row[] }>(bee, "GET", "/openApi/swap/v2/trade/allOrders", { symbol, limit: 100 });
        for (const o of r?.orders ?? []) {
          const id = String(o.orderId);
          if (ordIds.has(id)) out.set(id, (out.get(id) ?? 0) + Math.abs(Number(o.commission || 0)));
        }
      }
      return out;
    } catch (err) {
      log.warn("orders read failed", { bee, err: safeError(err) });
      return null;
    }
  }
}
