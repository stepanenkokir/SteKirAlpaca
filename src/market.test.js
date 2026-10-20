import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  averageDailyVolume,
  completedBars,
  evaluateBreakout,
  exitReason,
  isoFromNy,
  legsFromFill,
  minutesSinceMidnightNy,
  nyWallToUtc,
  openingRange,
  relativeOpenVolume,
  roundPrice,
  sessionDate,
  sessionPhase,
  sessionVwap,
  simulateTrade,
  shouldMoveStopToBreakeven,
  shouldReplaceLegs,
  sizePosition,
  stopFromRange,
} from "./market.js";

const DAY = "2026-06-15";

function bar({ hhmm, o, h, l, c, v }) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return {
    t: nyWallToUtc(`${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`),
    o,
    h,
    l,
    c,
    v,
  };
}

function rangeBars({ high, low, close, volume = 1000 }) {
  const bars = [];

  for (let minute = 30; minute < 45; minute += 1) {
    bars.push(
      bar({
        hhmm: `09:${minute}`,
        o: close,
        h: high,
        l: low,
        c: close,
        v: volume,
      }),
    );
  }

  return bars;
}

describe("session time", () => {
  it("formats the NY session date", () => {
    const noonEt = new Date(nyWallToUtc(`${DAY}T12:00:00`));
    assert.equal(sessionDate(noonEt), DAY);
    assert.equal(minutesSinceMidnightNy(noonEt), 12 * 60);
  });

  it("converts NY wall time through DST", () => {
    const summer = new Date(nyWallToUtc("2026-06-15T09:30:00"));
    const winter = new Date(nyWallToUtc("2026-01-15T09:30:00"));
    assert.equal(minutesSinceMidnightNy(summer), 9 * 60 + 30);
    assert.equal(minutesSinceMidnightNy(winter), 9 * 60 + 30);
    assert.equal(isoFromNy(summer, { hour: 9, minute: 30, second: 0 }), summer.toISOString());
  });
});

describe("opening range and VWAP", () => {
  it("uses the 15 bars from 09:30 through 09:44", () => {
    const bars = [
      ...rangeBars({ high: 101, low: 99, close: 100, volume: 10 }),
      bar({ hhmm: "09:45", o: 102, h: 103, l: 102, c: 103, v: 9999 }),
    ];
    const range = openingRange(bars);
    assert.equal(range.bars.length, 15);
    assert.equal(range.high, 101);
    assert.equal(range.low, 99);
    assert.equal(range.volume, 150);
  });

  it("computes session VWAP from typical price", () => {
    const bars = [
      bar({ hhmm: "09:30", o: 10, h: 12, l: 9, c: 11, v: 100 }),
      bar({ hhmm: "09:31", o: 11, h: 13, l: 10, c: 12, v: 100 }),
    ];
    const typicalA = (12 + 9 + 11) / 3;
    const typicalB = (13 + 10 + 12) / 3;
    assert.equal(sessionVwap(bars), (typicalA * 100 + typicalB * 100) / 200);
  });

  it("drops the in-progress minute bar", () => {
    const now = new Date(nyWallToUtc(`${DAY}T09:32:10`));
    const bars = [
      bar({ hhmm: "09:30", o: 1, h: 1, l: 1, c: 1, v: 1 }),
      bar({ hhmm: "09:31", o: 1, h: 1, l: 1, c: 1, v: 1 }),
      bar({ hhmm: "09:32", o: 9, h: 9, l: 9, c: 9, v: 1 }),
    ];
    assert.equal(completedBars(bars, now).length, 2);
  });
});

describe("evaluateBreakout", () => {
  const avgDaily = 100_000;
  const now = new Date(nyWallToUtc(`${DAY}T09:47:05`));

  function setup({ lastHigh = 102, lastLow = 101.5, lastClose = 102, volume = 2000 } = {}) {
    return [
      ...rangeBars({ high: 101, low: 100, close: 100.5, volume }),
      bar({ hhmm: "09:45", o: lastClose, h: lastHigh, l: lastLow, c: lastClose, v: volume }),
      bar({ hhmm: "09:46", o: lastClose, h: lastHigh, l: lastLow, c: lastClose, v: volume }),
    ];
  }

  it("accepts a close above the range, VWAP and volume", () => {
    const result = evaluateBreakout({
      bars: setup({ lastHigh: 101.3, lastLow: 101.1, lastClose: 101.2 }),
      now,
      avgDailyVolumeValue: avgDaily,
      rvolMin: 1.5,
    });
    assert.equal(result.ok, true);
    assert.equal(result.reason, "breakout");
    assert.equal(result.rangeHigh, 101);
    assert.ok(result.rvol > 1.5);
  });

  it("rejects a late chase more than half the range", () => {
    const result = evaluateBreakout({
      bars: setup({ lastHigh: 103, lastLow: 102.2, lastClose: 102.2 }),
      now,
      avgDailyVolumeValue: avgDaily,
      rvolMin: 1.5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "chase");
  });

  it("rejects a range that is too wide", () => {
    const bars = [
      ...rangeBars({ high: 104, low: 100, close: 102, volume: 2000 }),
      bar({ hhmm: "09:45", o: 104.2, h: 104.3, l: 104.1, c: 104.2, v: 2000 }),
      bar({ hhmm: "09:46", o: 104.2, h: 104.3, l: 104.1, c: 104.2, v: 2000 }),
    ];
    const result = evaluateBreakout({
      bars,
      now,
      avgDailyVolumeValue: avgDaily,
      rvolMin: 1.5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too_wide");
  });

  it("rejects a range that is too narrow", () => {
    const bars = [
      ...rangeBars({ high: 100.1, low: 100, close: 100.05, volume: 2000 }),
      bar({ hhmm: "09:45", o: 100.2, h: 100.21, l: 100.19, c: 100.2, v: 2000 }),
      bar({ hhmm: "09:46", o: 100.2, h: 100.21, l: 100.19, c: 100.2, v: 2000 }),
    ];
    const result = evaluateBreakout({
      bars,
      now,
      avgDailyVolumeValue: avgDaily,
      rvolMin: 1.5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "too_narrow");
  });

  it("rejects a close still inside the range", () => {
    const result = evaluateBreakout({
      bars: setup({ lastHigh: 100.8, lastLow: 100.4, lastClose: 100.7 }),
      now,
      avgDailyVolumeValue: avgDaily,
      rvolMin: 1.5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no_breakout");
  });

  it("rejects low relative volume", () => {
    const result = evaluateBreakout({
      bars: setup({ volume: 10 }),
      now,
      avgDailyVolumeValue: avgDaily,
      rvolMin: 1.5,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "low_rvol");
  });
});

describe("position size and prices", () => {
  it("rounds prices at or above $1 to two decimals", () => {
    assert.equal(roundPrice(188.196), 188.2);
    assert.equal(roundPrice(0.12346), 0.1235);
  });

  it("caps the stop at 1.2% when the range is wider", () => {
    assert.equal(stopFromRange({ entryPrice: 100, rangeLow: 97 }), 98.8);
    assert.equal(stopFromRange({ entryPrice: 100, rangeLow: 99.5 }), 99.5);
  });

  it("sizes by risk and caps notional", () => {
    const sized = sizePosition({
      equity: 10_000,
      buyingPower: 10_000,
      entryPrice: 100,
      stopPrice: 99,
      riskFraction: 0.005,
      maxPositionFraction: 0.25,
    });
    assert.equal(sized.qty, 25);
    assert.equal(sized.targetPrice, 102);
    assert.equal(sized.notional, 2500);
  });

  it("drops the idea when even one share exceeds the risk or notional cap", () => {
    const tooRisky = sizePosition({
      equity: 1000,
      buyingPower: 1000,
      entryPrice: 500,
      stopPrice: 490,
      riskFraction: 0.005,
      maxPositionFraction: 0.25,
    });
    assert.equal(tooRisky, null);
  });
});

describe("session phase", () => {
  const close = nyWallToUtc(`${DAY}T16:00:00`);

  it("waits through the opening range", () => {
    const now = new Date(nyWallToUtc(`${DAY}T09:40:00`));
    assert.equal(sessionPhase({ now, clock: { is_open: true, next_close: close }, hasPlanPositions: false }), "idle");
  });

  it("scans between 09:46 and 11:00", () => {
    const now = new Date(nyWallToUtc(`${DAY}T09:50:00`));
    assert.equal(sessionPhase({ now, clock: { is_open: true, next_close: close }, hasPlanPositions: false }), "scan");
  });

  it("watches after the scan window", () => {
    const now = new Date(nyWallToUtc(`${DAY}T12:00:00`));
    assert.equal(sessionPhase({ now, clock: { is_open: true, next_close: close }, hasPlanPositions: true }), "watch");
  });

  it("flattens five minutes before next_close when a plan position is open", () => {
    const now = new Date(nyWallToUtc(`${DAY}T15:56:00`));
    assert.equal(sessionPhase({ now, clock: { is_open: true, next_close: close }, hasPlanPositions: true }), "flatten");
    assert.equal(sessionPhase({ now, clock: { is_open: true, next_close: close }, hasPlanPositions: false }), "watch");
  });

  it("uses next_close for an early-close session", () => {
    const earlyClose = nyWallToUtc(`${DAY}T13:00:00`);
    const now = new Date(nyWallToUtc(`${DAY}T12:56:00`));
    assert.equal(
      sessionPhase({ now, clock: { is_open: true, next_close: earlyClose }, hasPlanPositions: true }),
      "flatten",
    );
  });

  it("stays idle when the session is closed", () => {
    const now = new Date(nyWallToUtc(`${DAY}T18:00:00`));
    assert.equal(sessionPhase({ now, clock: { is_open: false, next_close: close }, hasPlanPositions: true }), "idle");
  });
});

describe("exits and fills", () => {
  it("warns on lost VWAP, range return and session end", () => {
    assert.equal(
      exitReason({ lastClose: 99, rangeHigh: 101, rangeLow: 98, vwap: 100, minutesToClose: 60 }),
      "lost_vwap",
    );
    assert.equal(
      exitReason({ lastClose: 100.5, rangeHigh: 101, rangeLow: 98, vwap: 99, minutesToClose: 60 }),
      "back_in_range",
    );
    assert.equal(
      exitReason({ lastClose: 102, rangeHigh: 101, rangeLow: 98, vwap: 100, minutesToClose: 14 }),
      "session_end",
    );
    assert.equal(
      exitReason({ lastClose: 102, rangeHigh: 101, rangeLow: 98, vwap: 100, minutesToClose: 30 }),
      null,
    );
  });

  it("moves the stop to breakeven after 1R", () => {
    assert.equal(
      shouldMoveStopToBreakeven({ lastClose: 102, entryPrice: 100, r: 1, alreadyMoved: false }),
      true,
    );
    assert.equal(
      shouldMoveStopToBreakeven({ lastClose: 100.5, entryPrice: 100, r: 1, alreadyMoved: false }),
      false,
    );
  });

  it("replaces bracket legs when fill slippage exceeds 0.1R", () => {
    assert.equal(shouldReplaceLegs({ plannedEntry: 100, filledEntry: 100.2, r: 1 }), true);
    assert.equal(shouldReplaceLegs({ plannedEntry: 100, filledEntry: 100.05, r: 1 }), false);
    const legs = legsFromFill({ filledEntry: 100.2, stopPrice: 99, plannedEntry: 100 });
    assert.equal(legs.stopPrice, 99.2);
    assert.equal(legs.targetPrice, 102.2);
  });
});

describe("simulateTrade", () => {
  it("takes the stop when a later bar trades through it", () => {
    const bars = [
      ...rangeBars({ high: 101, low: 100, close: 100.5, volume: 2000 }),
      bar({ hhmm: "09:46", o: 101.2, h: 101.3, l: 101.1, c: 101.2, v: 2000 }),
      bar({ hhmm: "09:47", o: 101.1, h: 101.2, l: 99.4, c: 99.5, v: 2000 }),
    ];
    const result = simulateTrade({
      bars,
      entryTime: bars.at(-2).t,
      entryPrice: 101.2,
      stopPrice: 100,
      targetPrice: 103.6,
      rangeHigh: 101,
      rangeLow: 100,
      sessionClose: new Date(nyWallToUtc(`${DAY}T16:00:00`)),
    });
    assert.equal(result.reason, "stop_filled");
    assert.equal(result.price, 100);
  });
});

describe("volume helpers", () => {
  it("averages the last N daily bars", () => {
    const daily = Array.from({ length: 5 }, (_, i) => ({ v: (i + 1) * 10 }));
    assert.equal(averageDailyVolume(daily, 4), 35);
    assert.ok(relativeOpenVolume(24, 100) - 2 < 1e-9);
  });
});
