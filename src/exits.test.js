import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./alpaca.js";
import { BOT_COMMANDS, MENU_BUTTONS, mainMenuKeyboard } from "./bot.js";
import { createDesk, extractSymbols } from "./desk.js";
import { cancelTargets, flattenPosition } from "./exits.js";
import { nyWallToUtc } from "./market.js";
import { createOpenAiClient } from "./openai.js";
import { formatAccountNote, groupNewsBySymbol } from "./scanner.js";
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

describe("menu, news digest and assistant chat", () => {
  it("extracts tickers from commands and natural Russian questions", () => {
    const watchlist = ["AAPL", "NVDA", "MSFT"];
    assert.deepEqual(extractSymbols("/news AAPL nvda", watchlist), ["AAPL", "NVDA"]);
    assert.deepEqual(
      extractSymbols("Какие новости по nvda и $TSLA? Что с VWAP и ORB?", watchlist),
      ["NVDA", "TSLA"],
    );
    assert.deepEqual(extractSymbols("/news", watchlist), []);
    assert.deepEqual(extractSymbols("Новости", watchlist), []);
  });

  it("exposes native Telegram commands and reply keyboard buttons", () => {
    const commandNames = BOT_COMMANDS.map((item) => item.command);
    assert.ok(commandNames.includes("account"));
    assert.ok(commandNames.includes("news"));
    assert.ok(commandNames.includes("menu"));

    const keyboard = mainMenuKeyboard();
    assert.equal(keyboard.reply_markup.resize_keyboard, true);
    assert.deepEqual(keyboard.reply_markup.keyboard, [
      [MENU_BUTTONS.ACCOUNT, MENU_BUTTONS.POSITIONS, MENU_BUTTONS.PLAN],
      [MENU_BUTTONS.SCAN, MENU_BUTTONS.NEWS, MENU_BUTTONS.JOURNAL],
    ]);
  });

  it("falls back gracefully in OpenAI summarizeNews and answerQuestion on network errors", async () => {
    const client = createOpenAiClient({
      apiKey: "test-key",
      model: "gpt-4.1-mini",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    const digest = await client.summarizeNews({
      symbols: ["AAPL"],
      articles: [{ symbols: ["AAPL"], headline: "Apple launches new chip" }],
    });
    assert.match(digest.summary, /Свежие заголовки/);
    assert.deepEqual(digest.highlights, ["[AAPL] Apple launches new chip"]);

    const reply = await client.answerQuestion({
      question: "Что по AAPL?",
      context: {
        news: [{ symbols: ["AAPL"], headline: "Apple launches new chip" }],
      },
    });
    assert.match(reply.answer, /временно недоступен/);
    assert.match(reply.answer, /Apple launches new chip/);
  });

  it("formats newsDigest and askAssistant using Alpaca data and OpenAI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stock-analiz-chat-"));
    try {
      const store = createStore({ dataDir: dir });
      const now = new Date(nyWallToUtc("2026-06-15T10:15:00"));
      let capturedQuestion = null;
      let capturedContext = null;

      const alpaca = {
        async getAccount() {
          return {
            equity: "100500",
            cash: "80000",
            buying_power: "160000",
            status: "ACTIVE",
          };
        },
        async getPositions() {
          return [
            {
              symbol: "MSFT",
              qty: "10",
              avg_entry_price: "420",
              unrealized_pl: "50",
            },
          ];
        },
        async getLatestQuotes(symbols) {
          const quotes = {};
          for (const sym of symbols) {
            quotes[sym] = { bp: 199.5, ap: 200.0 };
          }
          return { quotes };
        },
        async getNews({ symbols }) {
          return {
            news: symbols.map((sym) => ({
              symbols: [sym],
              headline: `${sym} quarterly update`,
              summary: "Strong guidance",
              created_at: "2026-06-15T14:00:00Z",
            })),
          };
        },
      };

      const openai = {
        async summarizeNews({ symbols }) {
          return {
            summary: `Обзор по ${symbols.join(", ")}: позитивный фон.`,
            highlights: symbols.map((sym) => `${sym}: сильный прогноз`),
          };
        },
        async answerQuestion({ question, context }) {
          capturedQuestion = question;
          capturedContext = context;
          return {
            answer: `По ${context.mentionedSymbols.join(", ")} новости позитивные, позиция MSFT в плюсе.`,
          };
        },
      };

      const desk = createDesk({
        alpaca,
        openai,
        store,
        config: { watchlist: ["AAPL", "NVDA", "MSFT"] },
        notifier: { async send() {} },
      });

      const digestText = await desk.newsDigest("/news AAPL", now);
      assert.match(digestText, /Новости \(AAPL\) — 10:15 ET/);
      assert.match(digestText, /AAPL: bid \$199\.50 \/ ask \$200\.00/);
      assert.match(digestText, /Обзор по AAPL: позитивный фон\./);
      assert.match(digestText, /• AAPL: сильный прогноз/);

      const answer = await desk.askAssistant("Какие новости по nvda?", now);
      assert.equal(capturedQuestion, "Какие новости по nvda?");
      assert.deepEqual(capturedContext.mentionedSymbols, ["NVDA"]);
      assert.equal(capturedContext.positions[0].symbol, "MSFT");
      assert.ok(capturedContext.quotes.NVDA);
      assert.match(answer, /По NVDA новости позитивные/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("IEX stub quote protection, stop adjustment order and account note", () => {
  it("formats account note cleanly when PDT fields are absent in Alpaca API", () => {
    assert.equal(
      formatAccountNote({ status: "ACTIVE", multiplier: "4" }, {}),
      "Счёт: статус=ACTIVE, плечо=4x, pdt_check=н/д.",
    );
    assert.equal(
      formatAccountNote(
        { pattern_day_trader: false, daytrade_count: 1 },
        { pdt_check: "both" },
      ),
      "Счёт: PDT=false, day trades=1, pdt_check=both.",
    );
  });

  it("ignores wide IEX ask in buyIdea, rejects chase/broken breakout, and adjusts legs before fill notification", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stock-analiz-tsla-"));
    try {
      const store = createStore({ dataDir: dir });
      const day = "2026-10-22";
      const now = new Date(nyWallToUtc(`${day}T09:47:56`));
      const notifications = [];
      const replacedLegs = [];
      let submittedBracket = null;

      await store.saveSession({
        date: day,
        pdtNoted: true,
        lastScanMinute: 587,
        lastWatchMinute: 587,
        lastErrorAt: null,
        flattened: false,
        scanStarted: true,
        scanSummarySent: false,
        lastFilters: {},
        ideas: {
          TSLA: {
            symbol: "TSLA",
            ok: true,
            reason: "breakout",
            rangeHigh: 382.09,
            rangeLow: 374.07,
            rangePct: 0.0209,
            vwap: 378.0,
            rvol: 1.47,
            lastClose: 383.28,
            entryPrice: 383.66,
            qty: 65,
            r: 6.14,
            stopPrice: 377.52,
            targetPrice: 395.94,
            status: "signaled",
            notified: true,
            stopMovedToBe: false,
            notifiedEvents: [],
          },
        },
      });

      let snapshotTradePrice = 382.45;
      const alpaca = {
        async getClock() {
          return { is_open: true, next_close: nyWallToUtc(`${day}T16:00:00`) };
        },
        async getAccount() {
          return {
            equity: "99947",
            buying_power: "399788",
            status: "ACTIVE",
            multiplier: "4",
          };
        },
        async getSnapshot() {
          return {
            latestQuote: { ap: 386.0, bp: 372.0 },
            latestTrade: { p: snapshotTradePrice },
          };
        },
        async getLatestQuotes() {
          return { quotes: {} };
        },
        async submitBracketOrder(params) {
          submittedBracket = params;
          return { id: "ord-1", status: "pending_new" };
        },
        async getOrder() {
          return {
            id: "ord-1",
            status: "filled",
            filled_qty: "65",
            filled_avg_price: "381.90",
            legs: [
              { id: "leg-tp", status: "new", type: "limit", limit_price: String(submittedBracket.takeProfit) },
              { id: "leg-sl", status: "new", type: "stop", stop_price: String(submittedBracket.stopPrice) },
            ],
          };
        },
        async replaceOrder(id, patch) {
          replacedLegs.push({ id, ...patch });
          return { id };
        },
        async getStockBars() {
          return { TSLA: [] };
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
          watchlist: ["TSLA"],
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
        postBuyCheckDelayMs: 0,
      });

      snapshotTradePrice = 377.5;
      const rejectedBroken = await desk.buyIdea({ symbol: "TSLA", date: day, now });
      assert.equal(rejectedBroken.ok, false);
      assert.match(rejectedBroken.text, /пробой сломан/);

      snapshotTradePrice = 386.5;
      const rejectedChase = await desk.buyIdea({ symbol: "TSLA", date: day, now });
      assert.equal(rejectedChase.ok, false);
      assert.match(rejectedChase.text, /ушла слишком далеко/);

      snapshotTradePrice = 382.45;
      const bought = await desk.buyIdea({ symbol: "TSLA", date: day, now });
      assert.equal(bought.ok, true);
      assert.equal(submittedBracket.limitPrice, 382.83);
      assert.equal(submittedBracket.stopPrice, 376.7);

      await desk.tick(new Date(nyWallToUtc(`${day}T09:48:05`)));
      assert.equal(replacedLegs.length, 2);
      assert.equal(replacedLegs[0].id, "leg-sl");
      assert.equal(replacedLegs[0].stopPrice, 375.79);
      assert.equal(notifications.length, 1);
      assert.match(notifications[0], /Куплено TSLA 65 @ \$381\.90\. Стоп \$375\.79, цель \$394\.12\./);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
