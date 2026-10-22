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
    buyIdea,
    sellIdea,
    coverShort,
  };
}
