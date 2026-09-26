// Minimal BingX perpetual-swap REST client (https://bingx-api.github.io/docs). Public GETs and HMAC-signed calls.
// Live: open-api.bingx.com. Demo (VST, fake USDT on BingX's side): open-api-vst.bingx.com, same keys.
// Secrets: the key goes in the X-BX-APIKEY header, the secret only signs; neither is ever logged.
import { createHmac } from "node:crypto";
import { redactString } from "../redact.js";

export const BINGX_LIVE = "https://open-api.bingx.com";
export const BINGX_DEMO = "https://open-api-vst.bingx.com";

export interface BingxCreds {
  apiKey: string;
  secretKey: string;
}

export class BingxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BingxError";
  }
}

type Params = Record<string, string | number | boolean | undefined>;

export interface BingxClient {
  get<T>(path: string, params?: Params, ttlMs?: number): Promise<T>;
  signed<T>(method: "GET" | "POST" | "DELETE", path: string, creds: BingxCreds, params?: Params): Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 100410 = rate limited; 429 on the HTTP layer. */
const RETRYABLE = new Set(["100410", "429", "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504"]);

export function queryString(params: Params): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function sign(secret: string, qs: string): string {
  return createHmac("sha256", secret).update(qs).digest("hex");
}

export function createBingxClient(opts: { apiBase: string; timeoutMs: number; maxConcurrent?: number; fetch?: typeof fetch; now?: () => number }): BingxClient {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const maxConcurrent = opts.maxConcurrent ?? 8;
  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () => new Promise<void>((resolve) => (active < maxConcurrent ? (active++, resolve()) : queue.push(() => (active++, resolve()))));
  const release = () => {
    active--;
    queue.shift()?.();
  };
  // Merges identical public requests that land together (the tick's and the refresh's tickers, for example).
  const cache = new Map<string, { at: number; p: Promise<unknown> }>();

  async function call<T>(method: string, url: string, headers: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let code: string;
      let msg: string;
      try {
        const res = await f(url, { method, headers, signal: AbortSignal.timeout(opts.timeoutMs) });
        const j = (await res.json().catch(() => null)) as { code?: number | string; msg?: string; data?: T } | null;
        if (res.ok && j && Number(j.code) === 0) return j.data as T;
        code = j && j.code !== undefined && Number(j.code) !== 0 ? String(j.code) : `HTTP_${res.status}`;
        msg = j?.msg || `HTTP ${res.status}`;
      } finally {
        release();
      }
      if (RETRYABLE.has(code) && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new BingxError(code, redactString(msg).slice(0, 240));
    }
  }

  return {
    get<T>(path: string, params: Params = {}, ttlMs = 0): Promise<T> {
      const qs = queryString(params);
      const url = `${opts.apiBase}${path}${qs ? `?${qs}` : ""}`;
      const hit = cache.get(url);
      if (ttlMs > 0 && hit && now() - hit.at < ttlMs) return hit.p as Promise<T>;
      const p = call<T>("GET", url, {});
      if (ttlMs > 0) {
        cache.set(url, { at: now(), p });
        p.catch(() => cache.delete(url));
        if (cache.size > 2000) cache.clear();
      }
      return p;
    },
    signed<T>(method: "GET" | "POST" | "DELETE", path: string, creds: BingxCreds, params: Params = {}): Promise<T> {
      const qs = queryString({ ...params, timestamp: now() });
      const url = `${opts.apiBase}${path}?${qs}&signature=${sign(creds.secretKey, qs)}`;
      return call<T>(method, url, { "X-BX-APIKEY": creds.apiKey });
    },
  };
}
