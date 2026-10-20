import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSummary, summarizeEvents } from "./journal.js";

describe("journal summary", () => {
  it("matches the backtest printout fields", () => {
    const summary = summarizeEvents([
      { type: "signal" },
      { type: "signal" },
      { type: "decision", action: "bought" },
      { type: "exit", r: 2 },
      { type: "exit", r: -1 },
      { type: "exit", r: -0.2 },
      { type: "filter", reason: "low_rvol" },
      { type: "filter", reason: "low_rvol" },
    ]);

    assert.equal(summary.signals, 2);
    assert.equal(summary.taken, 1);
    assert.equal(summary.exits, 3);
    assert.equal(summary.maxLossStreak, 2);
    assert.equal(summary.filters.low_rvol, 2);
    assert.match(formatSummary(summary), /Сигналов: 2/);
    assert.match(formatSummary(summary), /Средний R: 0\.27/);
  });
});
