import { buyKeyboard, signalCardText } from "./cards.js";
import { countReasonValues, formatFilterCounts } from "./journal.js";
import {
  MAX_IDEAS_PER_DAY,
  averageDailyVolume,
  evaluateBreakout,
  formatNyClock,
  ideaSlotsUsed,
  isoFromNy,
  planEntry,
  priorDailyBars,
  scanWindowLabel,
} from "./market.js";

const SUMMARY_MAX_CHARS = 200;

export function createScanner({ alpaca, openai, store, config, notify }) {
  let dailyVolumeCache = { date: null, bySymbol: null };

  async function getAvgDailyVolumes(now, date) {
    if (dailyVolumeCache.date === date && dailyVolumeCache.bySymbol) {
      return dailyVolumeCache.bySymbol;
    }

    const dailyStart = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const dailyBars = await alpaca.getStockBars({
      symbols: config.watchlist,
      timeframe: "1Day",
      start: dailyStart,
      end: now.toISOString(),
    });

    const bySymbol = {};

    for (const symbol of config.watchlist) {
      bySymbol[symbol] = averageDailyVolume(
        priorDailyBars(dailyBars[symbol] ?? [], date),
      );
    }

    dailyVolumeCache = { date, bySymbol };
    return bySymbol;
  }

  async function scanSession({ session, now, date }) {
    await flushUnnotified(session, date);

    if (ideaSlotsUsed(session.ideas) >= MAX_IDEAS_PER_DAY) {
      return [];
    }

    const start = isoFromNy(now, { hour: 9, minute: 30, second: 0 });
    const [minuteBars, avgDailyBySymbol, account, quotesPayload] = await Promise.all([
      alpaca.getStockBars({
        symbols: config.watchlist,
        timeframe: "1Min",
        start,
        end: now.toISOString(),
      }),
      getAvgDailyVolumes(now, date),
      alpaca.getAccount(),
      alpaca.getLatestQuotes(config.watchlist),
    ]);

    const quotes = quotesPayload.quotes ?? quotesPayload;
    const candidates = [];
    session.lastFilters ??= {};

    for (const symbol of config.watchlist) {
      if (session.ideas[symbol]) {
        delete session.lastFilters[symbol];
        continue;
      }

      const result = evaluateBreakout({
        bars: minuteBars[symbol] ?? [],
        now,
        avgDailyVolumeValue: avgDailyBySymbol[symbol] ?? null,
        rvolMin: config.rvolMin,
        maxRangePct: config.maxRangePct,
      });

      if (!result.ok) {
        session.lastFilters[symbol] = result.reason;
        continue;
      }

      const ask = Number(quotes?.[symbol]?.ap ?? quotes?.[symbol]?.quote?.ap);
      const rawEntryPrice = Number.isFinite(ask) && ask > 0 ? ask : result.lastClose;
      const sized = planEntry({
        idea: result,
        rawEntryPrice,
        equity: Number(account.equity),
        buyingPower: Number(account.buying_power),
        entryBufferPct: config.entryBufferPct,
        riskFraction: config.riskFraction,
        maxPositionFraction: config.maxPositionFraction,
      });

      if (!sized) {
        session.lastFilters[symbol] = "no_size";
        continue;
      }

      candidates.push({
        symbol,
        ...result,
        ...sized,
      });
    }

    candidates.sort((a, b) => b.rvol - a.rvol);
    const slots = MAX_IDEAS_PER_DAY - ideaSlotsUsed(session.ideas);
    const picked = candidates.slice(0, slots);

    for (const overflow of candidates.slice(slots)) {
      session.lastFilters[overflow.symbol] = "max_ideas";
    }

    if (picked.length === 0) {
      await store.saveSession(session);
      return [];
    }

    const newsPayload = await alpaca
      .getNews({
        symbols: picked.map((item) => item.symbol),
        start: isoFromNy(now, { hour: 0, minute: 0, second: 0 }),
        limit: Math.max(10, picked.length * 5),
      })
      .catch(() => ({ news: [] }));
    const pdtNote = await takePdtNote(session, account);
    const newsBySymbol = groupNewsBySymbol(
      newsPayload.news ?? newsPayload.articles ?? [],
    );
    const added = [];

    for (const candidate of picked) {
      const symbolNews = newsBySymbol[candidate.symbol] ?? {
        headlines: [],
        news: [],
      };
      const idea = {
        ...candidate,
        status: "signaled",
        notified: false,
        stopMovedToBe: false,
        notifiedEvents: [],
        headlines: symbolNews.headlines,
        news: symbolNews.news,
      };
      session.ideas[candidate.symbol] = idea;
      delete session.lastFilters[candidate.symbol];
      await store.saveSession(session);
      await sendSignalCard(session, idea, date, pdtNote, now);
      added.push(candidate.symbol);
    }

    return added;
  }

  async function sendSignalCard(session, idea, date, pdtNote, now = new Date()) {
    const explanation = await openai.explainSignal({
      idea,
      headlines: idea.headlines,
      news: idea.news,
    });
    idea.explanation = { thesis: explanation.thesis, risk: explanation.risk };
    await store.appendJournal({
      type: "openai",
      symbol: idea.symbol,
      prompt: explanation.prompt,
      response: explanation.raw,
    });
    await store.appendJournal({
      type: "signal",
      symbol: idea.symbol,
      rangeHigh: idea.rangeHigh,
      rangeLow: idea.rangeLow,
      vwap: idea.vwap,
      rvol: idea.rvol,
      qty: idea.qty,
      entryPrice: idea.entryPrice,
      stopPrice: idea.stopPrice,
      targetPrice: idea.targetPrice,
      openai: idea.explanation,
    });
    console.log(
      `[${date} ${formatNyClock(now)}] Сигнал ORB: ${idea.symbol} цена=${idea.lastClose} RVOL=${idea.rvol.toFixed(2)}`,
    );
    await notify(
      signalCardText(idea, { pdtNote, explanation: idea.explanation }),
      buyKeyboard(date, idea.symbol),
    );
    idea.notified = true;
    await store.saveSession(session);
  }

  async function flushUnnotified(session, date) {
    for (const idea of Object.values(session.ideas)) {
      if (idea.status === "signaled" && !idea.notified) {
        await sendSignalCard(session, idea, date, null);
      }
    }
  }

  async function finishScanWindow({ session, now, date }) {
    const filters = session.lastFilters ?? {};

    for (const [symbol, reason] of Object.entries(filters)) {
      if (!session.ideas[symbol] && reason) {
        await store.appendJournal({
          type: "filter",
          symbol,
          date,
          reason,
        });
      }
    }

    const ideasCount = ideaSlotsUsed(session.ideas);
    const filterText = formatFilterCounts(countReasonValues(filters));

    console.log(
      `[${date} ${formatNyClock(now)}] Окно ORB завершено: идей ${ideasCount}/${MAX_IDEAS_PER_DAY}. Фильтры: ${filterText || "нет"}`,
    );

    if (ideasCount === 0) {
      const lines = [
        `Окно пробоя ${scanWindowLabel()} завершено: новых сигналов нет (проверено ${config.watchlist.length} тикеров).`,
      ];

      if (filterText) {
        lines.push(`Отсев: ${filterText}.`);
      }

      await notify(lines.join("\n"));
    }
  }

  async function takePdtNote(session, account) {
    if (session.pdtNoted) {
      return null;
    }

    session.pdtNoted = true;
    await store.saveSession(session);
    const conf = await alpaca.getAccountConfigurations().catch(() => ({}));
    return `Счёт: PDT=${account.pattern_day_trader}, day trades=${account.daytrade_count}, pdt_check=${conf.pdt_check ?? "н/д"}.`;
  }

  return {
    scanSession,
    finishScanWindow,
  };
}

export function groupNewsBySymbol(articles) {
  const map = {};

  for (const article of articles) {
    const headline = (article.headline || article.title || "").trim();

    if (!headline) {
      continue;
    }

    const summary = cleanSummary(article.summary);
    const promptItem = summary ? `${headline} — ${summary}` : headline;

    for (const symbol of article.symbols ?? []) {
      map[symbol] ??= { headlines: [], news: [] };
      if (map[symbol].headlines.length < 3) {
        map[symbol].headlines.push(headline);
        map[symbol].news.push(promptItem);
      }
    }
  }

  return map;
}

function cleanSummary(raw) {
  if (!raw || typeof raw !== "string") {
    return "";
  }

  const normalized = raw.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= SUMMARY_MAX_CHARS) {
    return normalized;
  }

  return `${normalized.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}
