import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "./alpaca.js";
import { cancelTargets, flattenPosition } from "./exits.js";

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
