import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./alpaca.js";
import { createDesk } from "./desk.js";
import { cancelTargets, flattenPosition } from "./exits.js";
import { nyWallToUtc } from "./market.js";
import { groupNewsBySymbol } from "./scanner.js";
import { createStore } from "./store.js";

describe("cancelTargets", () => {
  it("cancels the parent while the entry is still open", () => {
    assert.deepEqual(
      cancelTargets({ id: "parent", status: "new", legs: [{ id: "tp", status: "held" }] }),
      ["parent"],
    );
  });

  it("cancels open legs after the parent fills", () => {
    assert.deepEqual(
      cancelTargets({
        id: "parent",
        status: "filled",
        legs: [
          { id: "tp", status: "new" },
          { id: "sl", status: "new" },
        ],
      }),
      ["tp", "sl"],
    );
  });
});

describe("flattenPosition", () => {
  it("cancels the group, waits, then closes the long", async () => {
    const calls = [];
    let status = "new";
    const alpaca = {
      async getOrder(id) {
        calls.push(`getOrder:${id}:${status}`);
        return { id, status, legs: [] };
      },
      async cancelOrder(id) {
        calls.push(`cancel:${id}`);
        status = "canceled";
      },
      async getPosition(symbol) {
        calls.push(`getPosition:${symbol}`);
        if (calls.filter((item) => item.startsWith("close:")).length === 0) {
          return { symbol, qty: "12" };
        }

        throw new HttpError("position does not exist", 404);
      },
      async closePosition(symbol) {
        calls.push(`close:${symbol}`);
      },
    };

    const result = await flattenPosition({
      alpaca,
      symbol: "AAPL",
      parentOrderId: "parent",
      sleep: async () => {},
    });

    assert.equal(result.short, false);
    assert.ok(calls.includes("cancel:parent"));
    assert.ok(calls.includes("close:AAPL"));
  });

  it("reports a leftover short after both bracket legs fill", async () => {
    const alpaca = {
      async getOrder() {
        return {
          id: "parent",
          status: "filled",
          legs: [
            { id: "tp", status: "filled" },
            { id: "sl", status: "filled" },
          ],
        };
      },
      async cancelOrder() {},
      async getPosition() {
        return { symbol: "AAPL", qty: "-12" };
      },
      async closePosition() {},
    };

    const result = await flattenPosition({
      alpaca,
      symbol: "AAPL",
      parentOrderId: "parent",
      sleep: async () => {},
    });

    assert.equal(result.short, true);
    assert.equal(result.qty, -12);
  });
});

describe("scanner and desk session integrity", () => {
  it("groups news headlines and summaries per symbol", () => {
    const grouped = groupNewsBySymbol([
      {
        headline: "AAPL beats Q3",
        summary: "Revenue grew 14% YoY on strong services demand.",
        symbols: ["AAPL", "MSFT"],
      },
    ]);
    assert.deepEqual(grouped.AAPL.headlines, ["AAPL beats Q3"]);
    assert.deepEqual(grouped.AAPL.news, [
      "AAPL beats Q3 — Revenue grew 14% YoY on strong services demand.",
    ]);
  });

  it("preserves newly scanned ideas across the full tick and caches 1Day bars", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stock-analiz-"));
    try {
      const store = createStore({ dataDir: dir });
      const day = "2026-06-15";
      let dailyCalls = 0;

      const minuteBars = [];
      for (let m = 30; m < 45; m += 1) {
        minuteBars.push({
          t: nyWallToUtc(`${day}T09:${m}:00`),
          o: 100.5,
          h: 101,
          l: 100,
          c: 100.5,
          v: 2000,
        });
      }
      minuteBars.push({
        t: nyWallToUtc(`${day}T09:45:00`),
        o: 101.2,
        h: 101.3,
        l: 101.1,
        c: 101.2,
        v: 2000,
      });

      const alpaca = {
        async getClock() {
          return { is_open: true, next_close: nyWallToUtc(`${day}T16:00:00`) };
        },
        async getStockBars({ timeframe }) {
          if (timeframe === "1Day") {
            dailyCalls += 1;
            return {
              AAPL: [{ t: nyWallToUtc("2026-06-12T09:30:00"), v: 100_000 }],
            };
          }
          return { AAPL: minuteBars };
        },
        async getAccount() {
          return {
            equity: "100000",
            buying_power: "100000",
            pattern_day_trader: false,
            daytrade_count: 0,
          };
        },
        async getAccountConfigurations() {
          return { pdt_check: "both" };
        },
        async getLatestQuotes() {
          return { quotes: { AAPL: { ap: 101.2 } } };
        },
        async getNews() {
          return {
            news: [
              {
                headline: "Catalyst",
                summary: "Details",
                symbols: ["AAPL"],
              },
            ],
          };
        },
      };

      const openai = {
        async explainSignal({ news }) {
          return {
            thesis: "Тезис",
            risk: "Риск",
            prompt: { headlines: news },
            raw: { thesis: "Тезис", risk: "Риск" },
          };
        },
        async explainExit() {
          return { thesis: "Выход", action: "Продавать", prompt: {}, raw: {} };
        },
      };

      const desk = createDesk({
        alpaca,
        openai,
        store,
        config: {
          watchlist: ["AAPL"],
          rvolMin: 1.5,
          entryBufferPct: 0.001,
          riskFraction: 0.005,
          maxPositionFraction: 0.25,
          autoFlatten: true,
        },
        notifier: { async send() {} },
      });

      await desk.tick(new Date(nyWallToUtc(`${day}T09:46:05`)));
      await desk.tick(new Date(nyWallToUtc(`${day}T09:47:05`)));

      const session = await store.loadSession(day);
      assert.equal(session.ideas.AAPL?.status, "signaled");
      assert.equal(session.ideas.AAPL?.notified, true);
      assert.equal(dailyCalls, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("logs filter reasons to journal and sends summary at 11:00 ET when no signals found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stock-analiz-"));
    try {
      const store = createStore({ dataDir: dir });
      const day = "2026-06-15";
      const notifications = [];

      const minuteBars = [];
      for (let m = 30; m < 45; m += 1) {
        minuteBars.push({
          t: nyWallToUtc(`${day}T09:${m}:00`),
          o: 100.5,
          h: 101,
          l: 100,
          c: 100.5,
          v: 100,
        });
      }
      minuteBars.push({
        t: nyWallToUtc(`${day}T09:45:00`),
        o: 100.6,
        h: 100.8,
        l: 100.4,
        c: 100.7,
        v: 100,
      });

      const alpaca = {
        async getClock() {
          return { is_open: true, next_close: nyWallToUtc(`${day}T16:00:00`) };
        },
        async getStockBars({ timeframe }) {
          if (timeframe === "1Day") {
            return {
              AAPL: [{ t: nyWallToUtc("2026-06-12T09:30:00"), v: 100_000 }],
            };
          }
          return { AAPL: minuteBars };
        },
        async getAccount() {
          return {
            equity: "100000",
            buying_power: "100000",
            pattern_day_trader: false,
            daytrade_count: 0,
          };
        },
        async getLatestQuotes() {
          return { quotes: { AAPL: { ap: 100.7 } } };
        },
      };

      const openai = {
        async explainSignal() {
          return { thesis: "", risk: "", prompt: {}, raw: {} };
        },
        async explainExit() {
          return { thesis: "", action: "", prompt: {}, raw: {} };
        },
      };

      const desk = createDesk({
        alpaca,
        openai,
        store,
        config: {
          watchlist: ["AAPL"],
          rvolMin: 1.1,
          maxRangePct: 0.025,
          entryBufferPct: 0.001,
          riskFraction: 0.005,
          maxPositionFraction: 0.25,
          autoFlatten: true,
        },
        notifier: {
          async send(text) {
            notifications.push(text);
          },
        },
      });

      await desk.tick(new Date(nyWallToUtc(`${day}T09:46:05`)));
      await desk.tick(new Date(nyWallToUtc(`${day}T11:00:05`)));

      assert.equal(notifications.length, 1);
      assert.match(notifications[0], /новых сигналов нет/);
      assert.match(notifications[0], /no_breakout: 1/);

      const journal = await store.readJournal();
      assert.equal(journal.length, 1);
      assert.equal(journal[0].type, "filter");
      assert.equal(journal[0].symbol, "AAPL");
      assert.equal(journal[0].reason, "no_breakout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
