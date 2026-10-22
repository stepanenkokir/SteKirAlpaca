import { isNotFound } from "./alpaca.js";
import { coverKeyboard, reasonLabel, sellKeyboard } from "./cards.js";
import { flattenPosition } from "./exits.js";
import { formatMoney } from "./format.js";
import {
  ENTRY_TIMEOUT_MS,
  completedBars,
  exitReason,
  isoFromNy,
  isOpenOrderStatus,
  legsFromFill,
  minutesToClose,
  roundPrice,
  sessionVwap,
  shouldMoveStopToBreakeven,
  shouldReplaceLegs,
} from "./market.js";

export function createWatcher({ alpaca, openai, store, notify }) {
  async function watchOrders({ session, now }) {
    for (const idea of Object.values(session.ideas)) {
      if (!["ordered", "working", "filled"].includes(idea.status) || !idea.orderId) {
        continue;
      }

      let order;

      try {
        order = await alpaca.getOrder(idea.orderId);
      } catch (error) {
        if (isNotFound(error)) {
          continue;
        }

        throw error;
      }

      await handleOrderEvents(session, idea, order, now);
    }
  }

  async function handleOrderEvents(session, idea, order, now) {
    const events = idea.notifiedEvents ?? [];

    if (order.status === "partially_filled" && !events.includes("partial")) {
      events.push("partial");
      idea.notifiedEvents = events;
      await store.saveSession(session);
      await notify(
        `${idea.symbol}: частичное исполнение ${order.filled_qty} @ ${formatMoney(order.filled_avg_price)}.`,
      );
    }

    if (order.status === "filled" && idea.status !== "exited") {
      await adjustFilledLegs(idea, order);

      if (idea.status !== "filled") {
        await markFilled(session, idea, order);
      } else {
        await store.saveSession(session);
      }
    }

    if (["canceled", "expired", "rejected"].includes(order.status) && idea.status === "working") {
      idea.status = "canceled";
      await store.saveSession(session);
      await notify(`${idea.symbol}: вход ${order.status}.`);
    }

    if (
      idea.status === "working" &&
      isOpenOrderStatus(order.status) &&
      idea.orderedAt &&
      now.getTime() - Date.parse(idea.orderedAt) >= ENTRY_TIMEOUT_MS
    ) {
      await alpaca.cancelOrder(idea.orderId).catch(() => {});
      idea.status = "canceled";
      await store.saveSession(session);
      await notify(`${idea.symbol}: лимит не исполнился за 2 минуты, ордер снят.`);
      return;
    }

    for (const leg of order.legs ?? []) {
      if (leg.status !== "filled") {
        continue;
      }

      const key = isStopLeg(leg) ? "stop_filled" : "target_filled";

      if (events.includes(key)) {
        continue;
      }

      events.push(key);
      idea.notifiedEvents = events;
      const exitPrice = Number(leg.filled_avg_price ?? leg.limit_price ?? leg.stop_price);
      idea.status = "exited";
      idea.exitReason = key;
      await store.saveSession(session);
      await store.appendJournal({
        type: "exit",
        symbol: idea.symbol,
        reason: key,
        price: exitPrice,
        r: rMultiple(idea, exitPrice),
      });
      const label = key === "stop_filled" ? "Сработал стоп" : "Взята цель";
      await notify(`${idea.symbol}: ${label} @ ${formatMoney(exitPrice)}.`);
    }
  }

  async function markFilled(session, idea, order) {
    const filledEntry = Number(order.filled_avg_price);
    idea.filledAvgPrice = filledEntry;
    idea.filledQty = Number(order.filled_qty);
    idea.status = "filled";
    const slippage = filledEntry - idea.entryPrice;

    if (!idea.notifiedEvents.includes("entry_filled")) {
      idea.notifiedEvents.push("entry_filled");
    }

    await store.saveSession(session);
    await store.appendJournal({
      type: "fill",
      symbol: idea.symbol,
      price: filledEntry,
      qty: idea.filledQty,
      slippage,
    });
    await notify(
      `Куплено ${idea.symbol} ${idea.filledQty} @ ${formatMoney(filledEntry)}. Стоп ${formatMoney(idea.stopPrice)}, цель ${formatMoney(idea.targetPrice)}.`,
    );
  }

  async function watchPrices({ session, now, date, clock }) {
    const filled = Object.values(session.ideas).filter((idea) => idea.status === "filled");

    if (filled.length === 0) {
      return;
    }

    const start = isoFromNy(now, { hour: 9, minute: 30, second: 0 });
    const barsBySymbol = await alpaca.getStockBars({
      symbols: filled.map((idea) => idea.symbol),
      timeframe: "1Min",
      start,
      end: now.toISOString(),
    });
    const remaining = minutesToClose(now, clock);

    for (const idea of filled) {
      const bars = completedBars(barsBySymbol[idea.symbol] ?? [], now);
      const last = bars.at(-1);

      if (!last) {
        continue;
      }

      const vwap = sessionVwap(bars);
      idea.lastClose = last.c;
      idea.vwap = vwap;

      if (
        shouldMoveStopToBreakeven({
          lastClose: last.c,
          entryPrice: idea.filledAvgPrice ?? idea.entryPrice,
          r: idea.r,
          alreadyMoved: idea.stopMovedToBe,
        })
      ) {
        idea.stopMovedToBe = true;
        await store.saveSession(session);
        await moveStopToBreakeven(idea);
      }

      const reason = exitReason({
        lastClose: last.c,
        rangeHigh: idea.rangeHigh,
        rangeLow: idea.rangeLow,
        vwap,
        minutesToClose: remaining,
      });

      if (!reason || reason === idea.lastExitReason) {
        await store.saveSession(session);
        continue;
      }

      idea.lastExitReason = reason;
      await store.saveSession(session);
      const explanation = await openai.explainExit({ idea, reason });
      await store.appendJournal({
        type: "openai",
        symbol: idea.symbol,
        prompt: explanation.prompt,
        response: explanation.raw,
      });
      await notify(
        [
          `${idea.symbol}: сигнал к продаже (${reasonLabel(reason)})`,
          `Цена ${formatMoney(last.c)}  VWAP ${formatMoney(vwap)}`,
          explanation.thesis,
          explanation.action,
        ].join("\n"),
        sellKeyboard(date, idea.symbol),
      );
    }
  }

  async function moveStopToBreakeven(idea) {
    if (!idea.orderId) {
      return;
    }

    try {
      const order = await alpaca.getOrder(idea.orderId);
      const stopLeg = (order.legs ?? []).find(
        (leg) => isStopLeg(leg) && isOpenOrderStatus(leg.status),
      );

      if (!stopLeg) {
        return;
      }

      const stopPrice = roundPrice(idea.filledAvgPrice ?? idea.entryPrice);
      await alpaca.replaceOrder(stopLeg.id, { stopPrice });
      idea.stopPrice = stopPrice;
      await notify(`${idea.symbol}: стоп перенесён в безубыток ${formatMoney(stopPrice)}.`);
    } catch (error) {
      console.error(error);
    }
  }

  async function adjustFilledLegs(idea, order) {
    if (idea.legsAdjusted || (order.legs ?? []).length === 0) {
      return;
    }

    idea.legsAdjusted = true;
    const filledEntry = Number(order.filled_avg_price);

    if (
      !shouldReplaceLegs({
        plannedEntry: idea.entryPrice,
        filledEntry,
        r: idea.r,
      })
    ) {
      return;
    }

    const hasOpenLeg = (order.legs ?? []).some((leg) =>
      isOpenOrderStatus(leg.status),
    );

    if (!hasOpenLeg) {
      return;
    }

    const next = legsFromFill({
      filledEntry,
      stopPrice: idea.stopPrice,
      plannedEntry: idea.entryPrice,
      rangeLow: idea.rangeLow,
    });
    await replaceLegs(order, next);
    Object.assign(idea, next);
  }

  async function replaceLegs(order, next) {
    const stopLeg = (order.legs ?? []).find(
      (leg) => isStopLeg(leg) && isOpenOrderStatus(leg.status),
    );
    const targetLeg = (order.legs ?? []).find(
      (leg) => !isStopLeg(leg) && isOpenOrderStatus(leg.status),
    );

    if (stopLeg) {
      try {
        await alpaca.replaceOrder(stopLeg.id, { stopPrice: next.stopPrice });
      } catch (error) {
        console.error(error);
      }
    }

    if (targetLeg) {
      try {
        await alpaca.replaceOrder(targetLeg.id, { limitPrice: next.targetPrice });
      } catch (error) {
        console.error(error);
      }
    }
  }

  async function closeIdea({ session, idea, date, reason }) {
    if (!["ordered", "working", "filled"].includes(idea.status)) {
      return { ok: false, text: `${idea.symbol}: закрывать нечего.` };
    }

    const result = await flattenPosition({
      alpaca,
      symbol: idea.symbol,
      parentOrderId: idea.orderId,
    });
    const exitPrice = idea.lastClose ?? idea.filledAvgPrice ?? idea.entryPrice;

    if (result.short) {
      idea.status = "short";
      await store.saveSession(session);
      await notify(
        `${idea.symbol}: после выхода остался шорт ${result.qty}. Закройте его.`,
        coverKeyboard(date, idea.symbol),
      );
      return { ok: false, text: `${idea.symbol}: остался шорт ${result.qty}.` };
    }

    idea.status = "exited";
    idea.exitReason = reason;
    await store.saveSession(session);
    await store.appendJournal({
      type: "exit",
      symbol: idea.symbol,
      reason,
      price: exitPrice,
      r: rMultiple(idea, exitPrice),
    });
    return {
      ok: true,
      text: `${idea.symbol} закрыт (${reasonLabel(reason)}).`,
    };
  }

  async function flattenOpenIdeas({ session, date, reason }) {
    for (const idea of Object.values(session.ideas)) {
      if (!["ordered", "working", "filled"].includes(idea.status)) {
        continue;
      }

      const result = await closeIdea({
        session,
        idea,
        date,
        reason,
      });
      await notify(result.text);
    }
  }

  return {
    watchOrders,
    watchPrices,
    closeIdea,
    flattenOpenIdeas,
  };
}

export function isStopLeg(leg) {
  return Boolean(leg.stop_price) || leg.type === "stop" || leg.type === "stop_limit";
}

export function rMultiple(idea, exitPrice) {
  const entry = Number(idea.filledAvgPrice ?? idea.entryPrice);
  const r = Number(idea.r);

  if (!(r > 0) || !Number.isFinite(entry) || !Number.isFinite(exitPrice)) {
    return null;
  }

  return (exitPrice - entry) / r;
}
