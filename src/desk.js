import { isNotFound, isRateLimited } from "./alpaca.js";
import { buyKeyboard, coverKeyboard, sellKeyboard, signalCardText } from "./cards.js";
import { formatMoney } from "./format.js";
import { flattenPosition } from "./exits.js";
import { eventsSince, formatSummary, summarizeEvents } from "./journal.js";
import {
  DAILY_LOOKBACK,
  ENTRY_TIMEOUT_MS,
  MAX_IDEAS_PER_DAY,
  averageDailyVolume,
  completedBars,
  evaluateBreakout,
  exitReason,
  formatNyClock,
  ideaSlotsUsed,
  isoFromNy,
  isOpenOrderStatus,
  legsFromFill,
  minutesSinceMidnightNy,
  minutesToClose,
  openPlanCount,
  roundPrice,
  scanWindowLabel,
  sessionDate,
  sessionPhase,
  sessionVwap,
  shouldMoveStopToBreakeven,
  shouldReplaceLegs,
  sizePosition,
  stopFromRange,
} from "./market.js";

const ERROR_COOLDOWN_MS = 5 * 60 * 1000;

export function createDesk({ alpaca, openai, store, config, notifier }) {
  let tickInFlight = false;

  async function notify(text, extra) {
    if (typeof notifier.send === "function") {
      await notifier.send(text, extra);
    }
  }

  async function tick(now = new Date()) {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;

    try {
      await runTick(now);
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

    await watchOrders({ session, now });

    if (phase === "scan" && session.lastScanMinute !== minute) {
      session.lastScanMinute = minute;
      await store.saveSession(session);
      await scanSession({ now, date });
    }

    if (session.lastWatchMinute !== minute) {
      session.lastWatchMinute = minute;
      await store.saveSession(session);
      await watchPrices({ now, date, clock });
    }

    if (phase === "flatten" && config.autoFlatten && !session.flattened) {
      session.flattened = true;
      await store.saveSession(session);
      await flattenOpenIdeas({ date, reason: "auto_flatten" });
    }
  }

  async function scanNow(now = new Date()) {
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
      return [
        `Окно поиска пробоя: ${scanWindowLabel()}.`,
        `Сейчас ${formatNyClock(now)}, фаза ${phaseLabel(phase)}, сессия ${state}.`,
      ].join("\n");
    }

    const before = Object.keys(session.ideas);
    await scanSession({ now, date });
    const after = await store.loadSession(date);
    const added = Object.keys(after.ideas).filter((symbol) => !before.includes(symbol));

    if (added.length === 0) {
      return `Новых пробоев нет. Смотрю ${config.watchlist.length} тикеров, окно ${scanWindowLabel()}.`;
    }

    return `Отправил карточки: ${added.join(", ")}.`;
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

  async function buyIdea({ symbol, date, now = new Date() }) {
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

      const sized = sizeIdea({
        idea,
        entryPrice: roundPrice(ask * (1 + config.entryBufferPct)),
        equity: Number(account.equity),
        buyingPower: Number(account.buying_power),
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
  }

  async function sellIdea({ symbol, date, now = new Date() }) {
    const session = await store.loadSession(date);
    const idea = session.ideas[symbol];

    if (!idea) {
      return { ok: false, text: `Идеи ${symbol} нет.` };
    }

    return closeIdea({ session, idea, date, now, reason: idea.lastExitReason ?? "manual" });
  }

  async function coverShort({ symbol }) {
    try {
      const position = await alpaca.getPosition(symbol);
      const qty = Number(position.qty);

      if (!(qty < 0)) {
        return { ok: false, text: `Шорта по ${symbol} нет.` };
      }

      await alpaca.closePosition(symbol);
      return { ok: true, text: `Закрываю шорт ${symbol} ${qty}.` };
    } catch (error) {
      if (isNotFound(error)) {
        return { ok: false, text: `Позиции ${symbol} нет.` };
      }

      throw error;
    }
  }

  async function scanSession({ now, date }) {
    const session = await store.loadSession(date);
    await flushUnnotified(session, date);

    if (ideaSlotsUsed(session.ideas) >= MAX_IDEAS_PER_DAY) {
      return;
    }

    const start = isoFromNy(now, { hour: 9, minute: 30, second: 0 });
    const dailyStart = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const [minuteBars, dailyBars, account, quotesPayload] = await Promise.all([
      alpaca.getStockBars({
        symbols: config.watchlist,
        timeframe: "1Min",
        start,
        end: now.toISOString(),
      }),
      alpaca.getStockBars({
        symbols: config.watchlist,
        timeframe: "1Day",
        start: dailyStart,
        end: now.toISOString(),
      }),
      alpaca.getAccount(),
      alpaca.getLatestQuotes(config.watchlist),
    ]);

    const quotes = quotesPayload.quotes ?? quotesPayload;
    const candidates = [];

    for (const symbol of config.watchlist) {
      if (session.ideas[symbol]) {
        continue;
      }

      const result = evaluateBreakout({
        bars: minuteBars[symbol] ?? [],
        now,
        avgDailyVolumeValue: averageDailyVolume(
          priorDailyBars(dailyBars[symbol] ?? [], date),
        ),
        rvolMin: config.rvolMin,
      });

      if (!result.ok) {
        continue;
      }

      const ask = Number(quotes?.[symbol]?.ap ?? quotes?.[symbol]?.quote?.ap);
      const entryPrice = roundPrice(
        (Number.isFinite(ask) && ask > 0 ? ask : result.lastClose) *
          (1 + config.entryBufferPct),
      );
      const sized = sizeIdea({
        idea: result,
        entryPrice,
        equity: Number(account.equity),
        buyingPower: Number(account.buying_power),
      });

      if (!sized) {
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

    if (picked.length === 0) {
      return;
    }

    const newsPayload = await alpaca.getNews({
      symbols: picked.map((item) => item.symbol),
      start: isoFromNy(now, { hour: 0, minute: 0, second: 0 }),
      limit: 10,
    }).catch(() => ({ news: [] }));
    const pdtNote = await takePdtNote(session, account);
    const headlinesBySymbol = groupHeadlines(newsPayload.news ?? newsPayload.articles ?? []);

    for (const candidate of picked) {
      const idea = {
        ...candidate,
        status: "signaled",
        notified: false,
        stopMovedToBe: false,
        notifiedEvents: [],
        headlines: headlinesBySymbol[candidate.symbol] ?? [],
      };
      session.ideas[candidate.symbol] = idea;
      await store.saveSession(session);
      await sendSignalCard(session, idea, date, pdtNote);
    }
  }

  async function sendSignalCard(session, idea, date, pdtNote) {
    const explanation = await openai.explainSignal({
      idea,
      headlines: idea.headlines,
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
      await notify(`${idea.symbol}: частичное исполнение ${order.filled_qty} @ ${formatMoney(order.filled_avg_price)}.`);
    }

    if (order.status === "filled" && idea.status !== "exited") {
      if (idea.status !== "filled") {
        await markFilled(session, idea, order);
      }

      if (!idea.legsAdjusted && (order.legs ?? []).length > 0) {
        if (
          shouldReplaceLegs({
            plannedEntry: idea.entryPrice,
            filledEntry: idea.filledAvgPrice,
            r: idea.r,
          })
        ) {
          const next = legsFromFill({
            filledEntry: idea.filledAvgPrice,
            stopPrice: idea.stopPrice,
            plannedEntry: idea.entryPrice,
          });
          await replaceLegs(order, next);
          Object.assign(idea, next);
        }

        idea.legsAdjusted = true;
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

  async function watchPrices({ now, date, clock }) {
    const session = await store.loadSession(date);
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
      const stopLeg = (order.legs ?? []).find((leg) => isStopLeg(leg) && isOpenOrderStatus(leg.status));

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

  async function replaceLegs(order, next) {
    const stopLeg = (order.legs ?? []).find((leg) => isStopLeg(leg) && isOpenOrderStatus(leg.status));
    const targetLeg = (order.legs ?? []).find((leg) => !isStopLeg(leg) && isOpenOrderStatus(leg.status));

    if (targetLeg) {
      await alpaca.replaceOrder(targetLeg.id, { limitPrice: next.targetPrice });
    }

    if (stopLeg) {
      await alpaca.replaceOrder(stopLeg.id, { stopPrice: next.stopPrice });
    }
  }

  async function closeIdea({ session, idea, date, now, reason }) {
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

  async function flattenOpenIdeas({ date, reason }) {
    const session = await store.loadSession(date);

    for (const idea of Object.values(session.ideas)) {
      if (!["ordered", "working", "filled"].includes(idea.status)) {
        continue;
      }

      const result = await closeIdea({
        session,
        idea,
        date,
        now: new Date(),
        reason,
      });
      await notify(result.text);
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

  function sizeIdea({ idea, entryPrice, equity, buyingPower }) {
    const stopPrice = stopFromRange({
      entryPrice,
      rangeLow: idea.rangeLow,
    });
    const sized = sizePosition({
      equity,
      buyingPower,
      entryPrice,
      stopPrice,
      riskFraction: config.riskFraction,
      maxPositionFraction: config.maxPositionFraction,
    });

    if (!sized) {
      return null;
    }

    return {
      entryPrice,
      ...sized,
    };
  }

  return {
    tick,
    scanNow,
    planText,
    journalText,
    buyIdea,
    sellIdea,
    coverShort,
  };
}

function priorDailyBars(bars, today) {
  return bars.filter((bar) => sessionDate(new Date(bar.t)) < today).slice(-DAILY_LOOKBACK);
}

function groupHeadlines(articles) {
  const map = {};

  for (const article of articles) {
    const headline = article.headline || article.title;

    if (!headline) {
      continue;
    }

    for (const symbol of article.symbols ?? []) {
      map[symbol] ??= [];
      if (map[symbol].length < 3) {
        map[symbol].push(headline);
      }
    }
  }

  return map;
}

function isStopLeg(leg) {
  return Boolean(leg.stop_price) || leg.type === "stop" || leg.type === "stop_limit";
}

function rMultiple(idea, exitPrice) {
  const entry = Number(idea.filledAvgPrice ?? idea.entryPrice);
  const r = Number(idea.r);

  if (!(r > 0) || !Number.isFinite(entry) || !Number.isFinite(exitPrice)) {
    return null;
  }

  return (exitPrice - entry) / r;
}

function phaseLabel(phase) {
  return {
    idle: "ожидание диапазона",
    scan: "поиск пробоя",
    watch: "сопровождение",
    flatten: "закрытие сессии",
  }[phase] ?? phase;
}

function reasonLabel(reason) {
  return {
    lost_vwap: "потерян VWAP",
    back_in_range: "возврат в диапазон",
    session_end: "близко закрытие сессии",
    auto_flatten: "автозакрытие перед концом сессии",
    manual: "ручной выход",
    stop_filled: "стоп",
    target_filled: "цель",
  }[reason] ?? reason;
}
