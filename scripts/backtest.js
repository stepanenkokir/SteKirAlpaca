import { setTimeout as delay } from "node:timers/promises";
import { createAlpacaClient } from "../src/alpaca.js";
import { loadConfig } from "../src/config.js";
import { formatSummary, summarizeEvents } from "../src/journal.js";
import {
  MAX_IDEAS_PER_DAY,
  SCAN_END_MINUTES,
  SCAN_START_MINUTES,
  averageDailyVolume,
  evaluateBreakout,
  minutesSinceMidnightNy,
  nyWallToUtc,
  planEntry,
  priorDailyBars,
  sessionDate,
  simulateTrade,
} from "../src/market.js";

const SESSIONS = 90;
const PAPER_EQUITY = 100_000;

const config = loadConfig();
const alpaca = createAlpacaClient(config);

const calendarEnd = sessionDate(new Date());
const calendarStart = shiftDate(calendarEnd, -140);
const calendar = await withRetry(() =>
  alpaca.getCalendar({ start: calendarStart, end: calendarEnd }),
);
const sessions = calendar.filter((item) => item.date < calendarEnd).slice(-SESSIONS);

if (sessions.length === 0) {
  throw new Error("Нет исторических сессий для бэктеста");
}

console.log(`Сессий: ${sessions.length} (${sessions[0].date} — ${sessions.at(-1).date})`);
console.log(`Список: ${config.watchlist.join(", ")}`);

const dailyStart = nyWallToUtc(`${shiftDate(sessions[0].date, -40)}T09:30:00`);
const rangeStart = nyWallToUtc(`${sessions[0].date}T09:30:00`);
const rangeEnd = nyWallToUtc(`${sessions.at(-1).date}T16:00:00`);

const dailyBars = await withRetry(() =>
  alpaca.getStockBars({
    symbols: config.watchlist,
    timeframe: "1Day",
    start: dailyStart,
    end: rangeEnd,
  }),
);

const minuteBars = {};

for (const chunk of chunks(sessions, 5)) {
  const start = nyWallToUtc(`${chunk[0].date}T09:30:00`);
  const end = nyWallToUtc(`${chunk.at(-1).date}T16:00:00`);
  const part = await withRetry(() =>
    alpaca.getStockBars({
      symbols: config.watchlist,
      timeframe: "1Min",
      start,
      end,
    }),
  );
  mergeBars(minuteBars, part);
  process.stdout.write(".");
}

process.stdout.write("\n");

const barsBySymbolAndDate = {};

for (const symbol of config.watchlist) {
  barsBySymbolAndDate[symbol] = {};

  for (const bar of minuteBars[symbol] ?? []) {
    const day = sessionDate(new Date(bar.t));
    (barsBySymbolAndDate[symbol][day] ??= []).push(bar);
  }
}

const events = [];
let daySignals = 0;

for (const session of sessions) {
  const sessionClose = new Date(nyWallToUtc(`${session.date}T${toHms(session.close)}`));
  let used = 0;

  for (const symbol of config.watchlist) {
    const bars = barsBySymbolAndDate[symbol][session.date] ?? [];
    const avgDaily = averageDailyVolume(
      priorDailyBars(dailyBars[symbol] ?? [], session.date),
    );
    const scanTimes = uniqueScanTimes(bars);
    let lastReason = "no_bar";
    let picked = null;

    for (const now of scanTimes) {
      const result = evaluateBreakout({
        bars,
        now,
        avgDailyVolumeValue: avgDaily,
        rvolMin: config.rvolMin,
        maxRangePct: config.maxRangePct,
      });

      if (!result.ok) {
        lastReason = result.reason;
        continue;
      }

      const sized = planEntry({
        idea: result,
        rawEntryPrice: result.lastClose,
        equity: PAPER_EQUITY,
        buyingPower: PAPER_EQUITY,
        entryBufferPct: config.entryBufferPct,
        riskFraction: config.riskFraction,
        maxPositionFraction: config.maxPositionFraction,
      });

      if (!sized) {
        lastReason = "no_size";
        continue;
      }

      picked = {
        ...result,
        ...sized,
        now,
      };
      break;
    }

    if (!picked) {
      events.push({ type: "filter", reason: lastReason, symbol, date: session.date });
      continue;
    }

    if (used >= MAX_IDEAS_PER_DAY) {
      events.push({ type: "filter", reason: "max_ideas", symbol, date: session.date });
      continue;
    }

    used += 1;
    daySignals += 1;
    events.push({
      type: "signal",
      symbol,
      date: session.date,
      rvol: picked.rvol,
    });

    const trade = simulateTrade({
      bars,
      entryTime: picked.lastBarTime,
      entryPrice: picked.entryPrice,
      stopPrice: picked.stopPrice,
      targetPrice: picked.targetPrice,
      rangeHigh: picked.rangeHigh,
      rangeLow: picked.rangeLow,
      sessionClose,
    });
    const r = (trade.price - picked.entryPrice) / picked.r;
    events.push({
      type: "exit",
      symbol,
      date: session.date,
      reason: trade.reason,
      price: trade.price,
      r,
    });
  }
}

const summary = summarizeEvents(events);
console.log(`Сигналов в день: ${(daySignals / sessions.length).toFixed(2)}`);
console.log(formatSummary(summary));

function uniqueScanTimes(bars) {
  const times = [];

  for (const bar of bars) {
    const end = new Date(new Date(bar.t).getTime() + 60_000);
    const minutes = minutesSinceMidnightNy(end);

    if (minutes >= SCAN_START_MINUTES && minutes < SCAN_END_MINUTES) {
      times.push(end);
    }
  }

  return times;
}

function mergeBars(target, chunk) {
  for (const [symbol, list] of Object.entries(chunk)) {
    target[symbol] = (target[symbol] ?? []).concat(list);
  }
}

function chunks(list, size) {
  const result = [];

  for (let i = 0; i < list.length; i += size) {
    result.push(list.slice(i, i + size));
  }

  return result;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return sessionDate(date);
}

function toHms(hhmm) {
  return hhmm.length === 5 ? `${hhmm}:00` : hhmm;
}

async function withRetry(fn) {
  let lastError = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (error.status !== 429) {
        throw error;
      }

      await delay(15_000);
    }
  }

  throw lastError;
}
