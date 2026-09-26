import { describe, expect, it } from "vitest";
import { LIVE_ACK_PHRASE, loadConfig } from "../src/config.js";
import type { Settings } from "../src/settings.js";

describe("config", () => {
  it("DRY_RUN defaults to true, which forces dry whatever MODE says", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "live" }).mode).toBe("dry");
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "demo", DRY_RUN: "true" }).mode).toBe("dry");
  });

  it("refuses to start without the Jev key", () => {
    expect(() => loadConfig({})).toThrow(/TYPESAFE_API_KEY/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "  " })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("demo needs the BingX key and secret and lists the missing NAMES only", () => {
    const env = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo", BINGX_API_KEY: "secret-value-1" };
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/BINGX_API_SECRET/);
    expect(msg).not.toMatch(/BINGX_API_KEY\b/);
    expect(msg).not.toMatch(/secret-value-1/);
  });

  it("demo loads the BingX creds and points orders at the VST host; market data stays live", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "demo", BINGX_API_KEY: "K", BINGX_API_SECRET: "S" };
    const cfg = loadConfig(env);
    expect(cfg.mode).toBe("demo");
    expect(cfg.creds.bee1).toEqual({ apiKey: "K", secretKey: "S" });
    expect(cfg.bingx.apiBase).toBe("https://open-api-vst.bingx.com");
    expect(cfg.bingx.marketBase).toBe("https://open-api.bingx.com");
  });

  it("live needs the written risk acknowledgement, and demo/dry do not", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "live" };
    Object.assign(env, { BINGX_API_KEY: "K", BINGX_API_SECRET: "S" });
    expect(() => loadConfig(env)).toThrow(/LIVE_ACK/);
    expect(() => loadConfig({ ...env, LIVE_ACK: "yes" })).toThrow(/LIVE_ACK/);
    expect(loadConfig({ ...env, LIVE_ACK: LIVE_ACK_PHRASE }).mode).toBe("live");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).mode).toBe("dry");
  });

  it("with no Setup file the single bee is Bizzy", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.slots.bee1).toMatchObject({ style: "bizzy", name: "Bizzy", customImage: false });
    expect(Object.keys(c.slots)).toEqual(["bee1"]);
  });

  it("a Setup file supplies the Jev key and the bees; the environment still wins", () => {
    const settings: Settings = {
      version: 1,
      jevKey: "from-setup",
      acceptedRiskAt: 1,
      createdAt: 1,
      bees: [
        { name: "Granny", style: "breezy", tagline: "the calm one", rules: "Buy BTC dips.", coins: ["BTC"], image: true },
      ],
    };
    const c = loadConfig({}, settings);
    expect(c.jev.apiKey).toBe("from-setup");
    expect(c.mode).toBe("dry");
    expect(c.slots.bee1).toMatchObject({ name: "Granny", style: "breezy", customImage: true, rules: "Buy BTC dips.", coins: ["BTC"], fromSetup: true });
    expect(loadConfig({ TYPESAFE_API_KEY: "env" }, settings).jev.apiKey).toBe("env");
  });

  it("defaults match the strategy files", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.bees.bizzy).toMatchObject({ maxTradesPerDay: 1, feeBudgetUsdDay: 1, spreadGateBps: 5, maxFlatMinutes: 20 });
    expect(c.bees.boozy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 3, spreadGateBps: 15, maxFlatMinutes: 0 });
    expect(c.bees.breezy).toMatchObject({ maxTradesPerDay: 3, feeBudgetUsdDay: 1, maxFlatMinutes: 0, cooldownMinutes: 240 });
    expect(c.tickMs).toBe(10_000);
    expect(c.jev.dailyUsdCap).toBe(2);
    expect(c.dataRefreshMs).toBe(60_000);
    expect(c.risk.maxLeverage).toBe(2);
  });
});
