import { isNotFound, isRateLimited } from "./alpaca.js";
import { phaseLabel } from "./cards.js";
import { formatMoney } from "./format.js";
import {
  countReasonValues,
  eventsSince,
  formatFilterCounts,
  formatSummary,
  summarizeEvents,
} from "./journal.js";
import {
  MAX_IDEAS_PER_DAY,
  formatNyClock,
  minutesSinceMidnightNy,
  openPlanCount,
  planEntry,
  scanWindowLabel,
  sessionDate,
  sessionPhase,
} from "./market.js";
import { createScanner } from "./scanner.js";
import { createWatcher } from "./watcher.js";

const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const IGNORED_UPPER_WORDS = new Set([
  "ORB",
  "VWAP",
  "RVOL",
  "ET",
  "USD",
  "PDT",
  "IEX",
  "PNL",
  "AI",
  "API",
]);

export function extractSymbols(text = "", watchlist = []) {
  if (!text || typeof text !== "string") {
    return [];
  }

  const watchlistSet = new Set(watchlist.map((item) => item.toUpperCase()));
  const cleaned = text.replace(/^\/[a-z_]+(?:@[a-z0-9_]+)?\s*/i, "").trim();

  if (!cleaned) {
    return [];
  }

  const tokens = cleaned.match(/\$?[A-Za-z]{1,5}(?:\.[A-Za-z]{1,2})?/g) ?? [];
  const singleTickerQuery =
    /^[A-Za-z.\s,$]+$/.test(cleaned) && tokens.length <= 5;
  const found = [];

  for (const raw of tokens) {
    const hasDollar = raw.startsWith("$");
    const bare = hasDollar ? raw.slice(1) : raw;
    const upper = bare.toUpperCase();

    if (!/^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/.test(upper)) {
      continue;
    }

    if (!hasDollar && IGNORED_UPPER_WORDS.has(upper)) {
      continue;
    }

    const isUpper = bare === upper && bare.length >= 2;

    if (hasDollar || watchlistSet.has(upper) || isUpper || singleTickerQuery) {
      found.push(upper);
    }
  }

  return [...new Set(found)];
}

function normalizeQuotesMap(quotesPayload) {
  const rawQuotes = quotesPayload?.quotes ?? quotesPayload ?? {};
  const result = {};

  for (const [symbol, item] of Object.entries(rawQuotes)) {
    const quote = item?.quote ?? item;
    const bid = Number(quote?.bp);
    const ask = Number(quote?.ap);

    if (Number.isFinite(bid) || Number.isFinite(ask)) {
      result[symbol] = {
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
      };
    }
  }

  return result;
}

export function createDesk({ alpaca, openai, store, config, notifier }) {
  let tickInFlight = false;
  let actionChain = Promise.resolve();

  function serializeAction(task) {
    const run = actionChain.then(task, task);
    actionChain = run.catch(() => {});
    return run;
  }

  async function notify(text, extra) {
    if (typeof notifier?.send === "function") {
      await notifier.send(text, extra);
    }
  }

  const scanner = createScanner({ alpaca, openai, store, config, notify });
  const watcher = createWatcher({ alpaca, openai, store, notify });

  async function tick(now = new Date()) {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;

    try {
      await serializeAction(() => runTick(now));
    } catch (error) {
      if (isRateLimited(error)) {
        return;
      }

      console.error(error);
      await notifyError(error, now);
    } finally {
      tickInFlight = false;
    }
  }

  async function runTick(now) {
    const date = sessionDate(now);
    const session = await store.loadSession(date);
    const clock = await alpaca.getClock();
    const hasPlanPositions = openPlanCount(session.ideas) > 0;
    const phase = sessionPhase({ now, clock, hasPlanPositions });
    const minute = minutesSinceMidnightNy(now);

    await watcher.watchOrders({ session, now });

    if (phase === "scan" && session.lastScanMinute !== minute) {
      if (!session.scanStarted) {
        session.scanStarted = true;
        console.log(
          `[${date} ${formatNyClock(now)}] Старт сканирования ORB (${config.watchlist.length} тикеров, окно ${scanWindowLabel()})`,
        );
      }

      session.lastScanMinute = minute;
      await store.saveSession(session);
      await scanner.scanSession({ session, now, date });
    }

    if (phase === "watch" && session.scanStarted && !session.scanSummarySent) {
      session.scanSummarySent = true;
      await store.saveSession(session);
      await scanner.finishScanWindow({ session, now, date });
    }

    if (session.lastWatchMinute !== minute) {
      session.lastWatchMinute = minute;
      await store.saveSession(session);
      await watcher.watchPrices({ session, now, date, clock });
    }

    if (phase === "flatten" && config.autoFlatten && !session.flattened) {
      session.flattened = true;
      await store.saveSession(session);
      await watcher.flattenOpenIdeas({ session, date, reason: "auto_flatten" });
    }
  }

  function scanNow(now = new Date()) {
    return serializeAction(async () => {
      const clock = await alpaca.getClock();
      const date = sessionDate(now);
      const session = await store.loadSession(date);
      const phase = sessionPhase({
        now,
        clock,
        hasPlanPositions: openPlanCount(session.ideas) > 0,
      });

      if (phase !== "scan") {
        const state = clock.is_open ? "открыта" : "закрыта";
        const filterText = formatFilterCounts(countReasonValues(session.lastFilters));
        return [
          `Окно поиска пробоя: ${scanWindowLabel()}.`,
          `Сейчас ${formatNyClock(now)}, фаза ${phaseLabel(phase)}, сессия ${state}.`,
          filterText ? `Последний отсев: ${filterText}.` : null,
        ]
          .filter(Boolean)
          .join("\n");
      }

      const added = await scanner.scanSession({ session, now, date });

      if (added.length === 0) {
        const filterText = formatFilterCounts(countReasonValues(session.lastFilters));
        return [
          `Новых пробоев нет. Смотрю ${config.watchlist.length} тикеров, окно ${scanWindowLabel()}.`,
          filterText ? `Отсев: ${filterText}.` : null,
        ]
          .filter(Boolean)
          .join("\n");
      }

      return `Отправил карточки: ${added.join(", ")}.`;
    });
  }

  async function planText(now = new Date()) {
    const session = await store.loadSession(sessionDate(now));
    const ideas = Object.values(session.ideas);

    if (ideas.length === 0) {
      return `Идей на ${session.date} нет.`;
    }

    return ideas
      .map((idea) => {
        const fill = idea.filledAvgPrice
          ? ` вход ${formatMoney(idea.filledAvgPrice)}`
          : "";
        return `${idea.symbol} ${idea.status}${fill} qty ${idea.qty ?? "—"} стоп ${formatMoney(idea.stopPrice)} цель ${formatMoney(idea.targetPrice)}`;
      })
      .join("\n");
  }

  async function journalText(now = new Date()) {
    const events = await store.readJournal();
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return `Журнал за 7 дней\n${formatSummary(summarizeEvents(eventsSince(events, since)))}`;
  }

  async function newsDigest(symbolsInput = [], now = new Date()) {
    const explicitSymbols = Array.isArray(symbolsInput)
      ? symbolsInput.map((item) => item.trim().toUpperCase()).filter(Boolean)
      : extractSymbols(symbolsInput, config.watchlist);

    let targetSymbols = explicitSymbols.slice(0, 10);
    let label = targetSymbols.join(", ");

    if (targetSymbols.length === 0) {
      const [session, positions] = await Promise.all([
        store.loadSession(sessionDate(now)),
        alpaca.getPositions?.().catch(() => []) ?? [],
      ]);
      const activeSymbols = [
        ...new Set([
          ...positions.map((pos) => pos.symbol),
          ...Object.keys(session.ideas ?? {}),
        ]),
      ];

      if (activeSymbols.length > 0) {
        targetSymbols = activeSymbols.slice(0, 10);
        label = `позиции и идеи: ${targetSymbols.join(", ")}`;
      } else {
        targetSymbols = (config.watchlist ?? []).slice(0, 10);
        label = "вотчлист";
      }
    }

    const quoteSymbols =
      explicitSymbols.length > 0 ? explicitSymbols.slice(0, 5) : [];
    const [newsPayload, quotesPayload] = await Promise.all([
      alpaca
        .getNews({
          symbols: targetSymbols,
          limit: explicitSymbols.length > 0 ? 6 : 8,
        })
        .catch(() => ({ news: [] })),
      quoteSymbols.length > 0 && typeof alpaca.getLatestQuotes === "function"
        ? alpaca.getLatestQuotes(quoteSymbols).catch(() => ({}))
        : Promise.resolve({}),
    ]);

    const articles = newsPayload?.news ?? newsPayload?.articles ?? [];
    const quotes = normalizeQuotesMap(quotesPayload);
    const digest = await openai.summarizeNews({
      symbols: targetSymbols,
      articles,
      quotes,
    });

    const lines = [`Новости (${label}) — ${formatNyClock(now)}`];

    if (quoteSymbols.length > 0) {
      const quoteLines = quoteSymbols
        .map((sym) => {
          const q = quotes[sym];
          if (!q) {
            return null;
          }
          return `${sym}: bid ${q.bid != null ? formatMoney(q.bid) : "—"} / ask ${q.ask != null ? formatMoney(q.ask) : "—"}`;
        })
        .filter(Boolean);

      if (quoteLines.length > 0) {
        lines.push(quoteLines.join(" | "));
      }
    }

    lines.push("", digest.summary);

    if (digest.highlights?.length > 0) {
      lines.push(...digest.highlights.map((item) => `• ${item}`));
    }

    return lines.join("\n");
  }

  async function askAssistant(question, now = new Date()) {
    const mentioned = extractSymbols(question, config.watchlist);
    const [session, account, positions] = await Promise.all([
      store.loadSession(sessionDate(now)),
      alpaca.getAccount?.().catch(() => null) ?? null,
      alpaca.getPositions?.().catch(() => []) ?? [],
    ]);

    const activeSymbols = [
      ...new Set([
        ...mentioned,
        ...positions.map((pos) => pos.symbol),
        ...Object.keys(session.ideas ?? {}),
      ]),
    ];
    const newsSymbols =
      activeSymbols.length > 0
        ? activeSymbols.slice(0, 10)
        : (config.watchlist ?? []).slice(0, 10);
    const quoteSymbols = activeSymbols.slice(0, 10);

    const [newsPayload, quotesPayload] = await Promise.all([
      typeof alpaca.getNews === "function" && newsSymbols.length > 0
        ? alpaca.getNews({ symbols: newsSymbols, limit: 6 }).catch(() => ({ news: [] }))
        : Promise.resolve({ news: [] }),
      typeof alpaca.getLatestQuotes === "function" && quoteSymbols.length > 0
        ? alpaca.getLatestQuotes(quoteSymbols).catch(() => ({}))
        : Promise.resolve({}),
    ]);

    const articles = (newsPayload?.news ?? newsPayload?.articles ?? [])
      .slice(0, 6)
      .map((item) => ({
        symbols: item.symbols ?? [],
        headline: (item.headline || item.title || "").trim(),
        summary: String(item.summary ?? "").slice(0, 200),
        createdAt: item.created_at ?? null,
      }));

    const context = {
      timeEt: formatNyClock(now),
      sessionDate: session.date,
      mentionedSymbols: mentioned,
      account: account
        ? {
            equity: account.equity,
            cash: account.cash,
            buyingPower: account.buying_power,
            status: account.status,
          }
        : null,
      positions: positions.map((pos) => ({
        symbol: pos.symbol,
        qty: pos.qty,
        avgEntryPrice: pos.avg_entry_price,
        unrealizedPl: pos.unrealized_pl,
      })),
      ideas: Object.values(session.ideas ?? {}).map((idea) => ({
        symbol: idea.symbol,
        status: idea.status,
        entryPrice: idea.entryPrice,
        stopPrice: idea.stopPrice,
        targetPrice: idea.targetPrice,
        qty: idea.qty,
      })),
      quotes: normalizeQuotesMap(quotesPayload),
      news: articles,
    };

    const reply = await openai.answerQuestion({ question, context });
    return reply.answer;
  }

  function buyIdea({ symbol, date, now = new Date() }) {
    return serializeAction(async () => {
      if (sessionDate(now) !== date) {
        return { ok: false, text: "Карточка с другого дня." };
      }

      const session = await store.loadSession(date);
      const idea = session.ideas[symbol];

      if (!idea) {
        return { ok: false, text: `Идеи ${symbol} нет.` };
      }

      if (["ordered", "working", "filled"].includes(idea.status)) {
        return { ok: false, text: "Ордер уже отправлен." };
      }

      if (idea.status !== "signaled") {
        return { ok: false, text: `Сейчас статус ${idea.status}.` };
      }

      if (openPlanCount(session.ideas) >= MAX_IDEAS_PER_DAY) {
        return { ok: false, text: "Уже три позиции плана." };
      }

      idea.status = "ordered";
      idea.orderedAt = now.toISOString();
      await store.saveSession(session);

      try {
        const [quotePayload, account] = await Promise.all([
          alpaca.getLatestQuote(symbol),
          alpaca.getAccount(),
        ]);
        const ask = Number(quotePayload?.quote?.ap);

        if (!Number.isFinite(ask) || ask <= 0) {
          throw new Error(`Нет ask для ${symbol}`);
        }

        const sized = planEntry({
          idea,
          rawEntryPrice: ask,
          equity: Number(account.equity),
          buyingPower: Number(account.buying_power),
          entryBufferPct: config.entryBufferPct,
          riskFraction: config.riskFraction,
          maxPositionFraction: config.maxPositionFraction,
        });

        if (!sized) {
          idea.status = "signaled";
          await store.saveSession(session);
          return { ok: false, text: "Размер не проходит по риску или buying power." };
        }

        Object.assign(idea, sized);
        const order = await alpaca.submitBracketOrder({
          symbol,
          qty: idea.qty,
          limitPrice: idea.entryPrice,
          takeProfit: idea.targetPrice,
          stopPrice: idea.stopPrice,
        });
        idea.orderId = order.id;
        idea.status = "working";
        await store.saveSession(session);
        await store.appendJournal({
          type: "decision",
          symbol,
          action: "bought",
          orderId: order.id,
          qty: idea.qty,
          limitPrice: idea.entryPrice,
        });
        return {
          ok: true,
          text: `Ордер ${symbol} ${idea.qty} @ ${formatMoney(idea.entryPrice)} отправлен. Статус: ${order.status}.`,
        };
      } catch (error) {
        idea.status = "signaled";
        idea.lastError = error.message;
        await store.saveSession(session);
        throw error;
      }
    });
  }

  function sellIdea({ symbol, date, now = new Date() }) {
    return serializeAction(async () => {
      const session = await store.loadSession(date);
      const idea = session.ideas[symbol];

      if (!idea) {
        return { ok: false, text: `Идеи ${symbol} нет.` };
      }

      return watcher.closeIdea({
        session,
        idea,
        date,
        reason: idea.lastExitReason ?? "manual",
      });
    });
  }

  function coverShort({ symbol, date, now = new Date() }) {
    return serializeAction(async () => {
      try {
        const position = await alpaca.getPosition(symbol);
        const qty = Number(position.qty);

        if (!(qty < 0)) {
          return { ok: false, text: `Шорта по ${symbol} нет.` };
        }

        await alpaca.closePosition(symbol);
        const targetDate = date ?? sessionDate(now);
        const session = await store.loadSession(targetDate);
        const idea = session.ideas[symbol];

        if (idea) {
          idea.status = "exited";
          idea.exitReason = "manual";
          await store.saveSession(session);
        }

        return { ok: true, text: `Закрываю шорт ${symbol} ${qty}.` };
      } catch (error) {
        if (isNotFound(error)) {
          return { ok: false, text: `Позиции ${symbol} нет.` };
        }

        throw error;
      }
    });
  }

  async function notifyError(error, now) {
    const session = await store.loadSession(sessionDate(now));
    const last = session.lastErrorAt ? Date.parse(session.lastErrorAt) : 0;

    if (now.getTime() - last < ERROR_COOLDOWN_MS) {
      return;
    }

    session.lastErrorAt = now.toISOString();
    await store.saveSession(session);
    await notify(`Ошибка: ${error.message}`);
  }

  return {
    tick,
    scanNow,
    planText,
    journalText,
    newsDigest,
    askAssistant,
    buyIdea,
    sellIdea,
    coverShort,
  };
}
