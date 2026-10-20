export const NY_TZ = "America/New_York";
export const SESSION_OPEN_MINUTES = 9 * 60 + 30;
export const ORB_END_MINUTES = 9 * 60 + 45;
export const SCAN_START_MINUTES = 9 * 60 + 46;
export const SCAN_END_MINUTES = 11 * 60;
export const OPENING_VOLUME_FRACTION = 0.12;
export const MIN_RANGE_PCT = 0.0015;
export const MAX_RANGE_PCT = 0.02;
export const MAX_STOP_PCT = 0.012;
export const REWARD_R = 2;
export const MAX_IDEAS_PER_DAY = 3;
export const BREAKEVEN_R = 1;
export const REPLACE_LEGS_THRESHOLD_R = 0.1;
export const ENTRY_TIMEOUT_MS = 2 * 60 * 1000;
export const EXIT_WARN_MINUTES = 15;
export const FLATTEN_MINUTES = 5;
export const DAILY_LOOKBACK = 20;

const TERMINAL_ORDER_STATUSES = new Set([
  "filled",
  "canceled",
  "expired",
  "rejected",
  "done_for_day",
  "replaced",
]);

export function nyParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const map = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function sessionDate(date) {
  const parts = nyParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function minutesSinceMidnightNy(date) {
  const parts = nyParts(date);
  return parts.hour * 60 + parts.minute;
}

export function formatNyClock(date) {
  const parts = nyParts(date);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} ET`;
}

export function isoFromNy(date, { hour, minute, second = 0 } = {}) {
  const parts = nyParts(date);
  const y = parts.year;
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  const hh = String(hour ?? parts.hour).padStart(2, "0");
  const mm = String(minute ?? parts.minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return nyWallToUtc(`${y}-${m}-${d}T${hh}:${mm}:${ss}`);
}

export function nyWallToUtc(wall) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(wall);

  if (!match) {
    throw new Error(`Invalid NY wall time: ${wall}`);
  }

  const [, year, month, day, hour, minute, second] = match.map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let i = 0; i < 3; i += 1) {
    const parts = nyParts(new Date(guess));
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
    guess += wanted - asUtc;
  }

  return new Date(guess).toISOString();
}

export function roundPrice(price) {
  if (!Number.isFinite(price)) {
    return price;
  }

  if (price >= 1) {
    return Math.round(price * 100) / 100;
  }

  return Math.round(price * 10000) / 10000;
}

export function completedBars(bars, now) {
  const cutoff = now.getTime();
  return bars.filter((bar) => new Date(bar.t).getTime() + 60_000 <= cutoff);
}

export function openingRange(bars) {
  const opening = bars.filter((bar) => {
    const minutes = minutesSinceMidnightNy(new Date(bar.t));
    return minutes >= SESSION_OPEN_MINUTES && minutes < ORB_END_MINUTES;
  });

  if (opening.length === 0) {
    return null;
  }

  return {
    high: Math.max(...opening.map((bar) => bar.h)),
    low: Math.min(...opening.map((bar) => bar.l)),
    volume: opening.reduce((sum, bar) => sum + bar.v, 0),
    bars: opening,
  };
}

export function sessionVwap(bars) {
  let pv = 0;
  let volume = 0;

  for (const bar of bars) {
    const minutes = minutesSinceMidnightNy(new Date(bar.t));

    if (minutes < SESSION_OPEN_MINUTES) {
      continue;
    }

    const typical = (bar.h + bar.l + bar.c) / 3;
    pv += typical * bar.v;
    volume += bar.v;
  }

  if (volume <= 0) {
    return null;
  }

  return pv / volume;
}

export function averageDailyVolume(dailyBars, lookback = DAILY_LOOKBACK) {
  const closed = dailyBars.slice(-lookback);

  if (closed.length === 0) {
    return null;
  }

  const total = closed.reduce((sum, bar) => sum + bar.v, 0);
  return total / closed.length;
}

export function relativeOpenVolume(openVolume, avgDailyVolume) {
  const typicalOpen = avgDailyVolume * OPENING_VOLUME_FRACTION;

  if (!typicalOpen || typicalOpen <= 0) {
    return null;
  }

  return openVolume / typicalOpen;
}

export function stopFromRange({ entryPrice, rangeLow, maxStopPct = MAX_STOP_PCT }) {
  const floorStop = entryPrice * (1 - maxStopPct);
  return roundPrice(Math.max(rangeLow, floorStop));
}

export function sizePosition({
  equity,
  buyingPower,
  entryPrice,
  stopPrice,
  riskFraction,
  maxPositionFraction,
}) {
  const riskPerShare = entryPrice - stopPrice;

  if (!(riskPerShare > 0) || !(entryPrice > 0) || !(equity > 0)) {
    return null;
  }

  const riskDollars = equity * riskFraction;
  const maxNotional = equity * maxPositionFraction;
  const byRisk = Math.floor(riskDollars / riskPerShare);
  const byNotional = Math.floor(maxNotional / entryPrice);
  const byBuyingPower = Math.floor(buyingPower / entryPrice);
  const qty = Math.min(byRisk, byNotional, byBuyingPower);

  if (qty < 1) {
    return null;
  }

  const r = riskPerShare;
  const targetPrice = roundPrice(entryPrice + REWARD_R * r);

  return {
    qty,
    r,
    stopPrice: roundPrice(stopPrice),
    targetPrice,
    notional: roundPrice(qty * entryPrice),
    riskDollars: roundPrice(qty * r),
  };
}

export function evaluateBreakout({
  bars,
  now,
  avgDailyVolumeValue,
  rvolMin,
}) {
  const ready = completedBars(bars, now);
  const range = openingRange(ready);

  if (!range) {
    return { ok: false, reason: "no_range" };
  }

  const last = ready.at(-1);

  if (!last) {
    return { ok: false, reason: "no_bar" };
  }

  const lastMinutes = minutesSinceMidnightNy(new Date(last.t));

  if (lastMinutes < SCAN_START_MINUTES - 1) {
    return { ok: false, reason: "too_early" };
  }

  const vwap = sessionVwap(ready);

  if (vwap == null) {
    return { ok: false, reason: "no_vwap" };
  }

  const rangePct = (range.high - range.low) / last.c;

  if (rangePct < MIN_RANGE_PCT) {
    return reject("too_narrow", { range, vwap, last });
  }

  if (rangePct > MAX_RANGE_PCT) {
    return reject("too_wide", { range, vwap, last });
  }

  if (last.c <= range.high) {
    return reject("no_breakout", { range, vwap, last });
  }

  if (last.c <= vwap) {
    return reject("below_vwap", { range, vwap, last });
  }

  const rvol = relativeOpenVolume(range.volume, avgDailyVolumeValue);

  if (rvol == null) {
    return reject("no_rvol", { range, vwap, last });
  }

  if (rvol < rvolMin) {
    return reject("low_rvol", { range, vwap, last, rvol });
  }

  const rangeWidth = range.high - range.low;
  const extension = last.c - range.high;

  if (extension > rangeWidth / 2) {
    return reject("chase", { range, vwap, last, rvol });
  }

  return {
    ok: true,
    reason: "breakout",
    rangeHigh: range.high,
    rangeLow: range.low,
    rangePct,
    vwap,
    rvol,
    lastClose: last.c,
    lastBarTime: last.t,
    openVolume: range.volume,
  };
}

export function sessionPhase({ now, clock, hasPlanPositions }) {
  const minutes = minutesSinceMidnightNy(now);
  const nextClose = clock.next_close ? new Date(clock.next_close) : null;
  const minutesToClose = nextClose
    ? (nextClose.getTime() - now.getTime()) / 60_000
    : null;

  if (
    clock.is_open &&
    hasPlanPositions &&
    minutesToClose != null &&
    minutesToClose <= FLATTEN_MINUTES
  ) {
    return "flatten";
  }

  if (!clock.is_open) {
    return "idle";
  }

  if (minutes >= SCAN_START_MINUTES && minutes < SCAN_END_MINUTES) {
    return "scan";
  }

  if (minutes < ORB_END_MINUTES) {
    return "idle";
  }

  return "watch";
}

export function minutesToClose(now, clock) {
  if (!clock.next_close) {
    return null;
  }

  return (new Date(clock.next_close).getTime() - now.getTime()) / 60_000;
}

export function exitReason({ lastClose, rangeHigh, rangeLow, vwap, minutesToClose: remaining }) {
  if (remaining != null && remaining <= EXIT_WARN_MINUTES) {
    return "session_end";
  }

  if (lastClose < vwap) {
    return "lost_vwap";
  }

  if (lastClose <= rangeHigh && lastClose >= rangeLow) {
    return "back_in_range";
  }

  return null;
}

export function shouldMoveStopToBreakeven({ lastClose, entryPrice, r, alreadyMoved }) {
  if (alreadyMoved || !(r > 0)) {
    return false;
  }

  return lastClose >= entryPrice + BREAKEVEN_R * r;
}

export function shouldReplaceLegs({ plannedEntry, filledEntry, r }) {
  if (!(r > 0) || plannedEntry == null || filledEntry == null) {
    return false;
  }

  return Math.abs(filledEntry - plannedEntry) / r > REPLACE_LEGS_THRESHOLD_R;
}

export function legsFromFill({ filledEntry, stopPrice, plannedEntry }) {
  const originalR = plannedEntry - stopPrice;
  const stopDistance = Math.min(originalR, filledEntry * MAX_STOP_PCT);
  const nextStop = roundPrice(filledEntry - stopDistance);
  const nextTarget = roundPrice(filledEntry + REWARD_R * (filledEntry - nextStop));

  return {
    stopPrice: nextStop,
    targetPrice: nextTarget,
    r: filledEntry - nextStop,
  };
}

export function isOpenOrderStatus(status) {
  return Boolean(status) && !TERMINAL_ORDER_STATUSES.has(status);
}

export function ideaSlotsUsed(ideas) {
  return Object.keys(ideas ?? {}).length;
}

export function openPlanCount(ideas) {
  return Object.values(ideas ?? {}).filter((idea) =>
    ["ordered", "working", "filled"].includes(idea.status),
  ).length;
}

export function scanWindowLabel() {
  return "09:46–11:00 ET";
}

export function simulateTrade({
  bars,
  entryTime,
  entryPrice,
  stopPrice,
  targetPrice,
  rangeHigh,
  rangeLow,
  sessionClose,
}) {
  const prefix = bars.filter((bar) => new Date(bar.t) <= new Date(entryTime));
  const after = bars.filter((bar) => new Date(bar.t) > new Date(entryTime));

  for (const bar of after) {
    prefix.push(bar);

    if (bar.l <= stopPrice) {
      return { reason: "stop_filled", price: stopPrice };
    }

    if (bar.h >= targetPrice) {
      return { reason: "target_filled", price: targetPrice };
    }

    const reason = exitReason({
      lastClose: bar.c,
      rangeHigh,
      rangeLow,
      vwap: sessionVwap(prefix),
      minutesToClose: (sessionClose.getTime() - new Date(bar.t).getTime()) / 60_000,
    });

    if (reason) {
      return { reason, price: bar.c };
    }
  }

  const last = after.at(-1) ?? prefix.at(-1);
  return { reason: "session_end", price: last?.c ?? entryPrice };
}

function reject(reason, extras) {
  return {
    ok: false,
    reason,
    rangeHigh: extras.range.high,
    rangeLow: extras.range.low,
    vwap: extras.vwap,
    lastClose: extras.last.c,
    rvol: extras.rvol ?? null,
  };
}
