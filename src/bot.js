import { Markup, Telegraf } from "telegraf";
import { formatMoney } from "./format.js";
import { APP_VERSION } from "./version.js";

const SYMBOL_PATTERN = /^[A-Z.]{1,10}$/;
const pendingOrders = new Map();

export const BOT_COMMANDS = [
  { command: "account", description: "Баланс и buying power" },
  { command: "positions", description: "Открытые позиции" },
  { command: "plan", description: "Идеи дня" },
  { command: "scan", description: "Проверить пробои сейчас" },
  { command: "news", description: "Свежие новости (/news или /news AAPL)" },
  { command: "quote", description: "Котировка тикера (/quote AAPL)" },
  { command: "journal", description: "Журнал за 7 дней" },
  { command: "menu", description: "Показать кнопки меню" },
  { command: "version", description: "Версия бота" },
];

export const MENU_BUTTONS = {
  ACCOUNT: "Баланс",
  POSITIONS: "Позиции",
  PLAN: "План",
  SCAN: "Скан",
  NEWS: "Новости",
  JOURNAL: "Журнал",
};

export function mainMenuKeyboard() {
  return Markup.keyboard([
    [MENU_BUTTONS.ACCOUNT, MENU_BUTTONS.POSITIONS, MENU_BUTTONS.PLAN],
    [MENU_BUTTONS.SCAN, MENU_BUTTONS.NEWS, MENU_BUTTONS.JOURNAL],
  ]).resize();
}

export function parseOrderArgs(text) {
  const [, symbolRaw, qtyRaw] = text.trim().split(/\s+/);
  const symbol = symbolRaw?.toUpperCase();
  const qty = Number(qtyRaw);

  if (!SYMBOL_PATTERN.test(symbol ?? "") || !Number.isInteger(qty) || qty <= 0) {
    return null;
  }

  return { symbol, qty };
}

export function parseQuoteSymbol(text) {
  const [, symbolRaw] = text.trim().split(/\s+/);
  const symbol = symbolRaw?.toUpperCase();
  return SYMBOL_PATTERN.test(symbol ?? "") ? symbol : null;
}

function isAllowedUser(ctx, allowedUserId) {
  return ctx.from?.id === allowedUserId;
}

export function createBot({ token, allowedUserId, alpaca, desk }) {
  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    if (!isAllowedUser(ctx, allowedUserId)) {
      return;
    }

    return next();
  });

  function sendStartMenu(ctx) {
    return ctx.reply(
      [
        `Paper-счёт Alpaca. v${APP_VERSION}`,
        "",
        "/account — баланс",
        "/positions — позиции",
        "/plan — идеи дня",
        "/scan — проверить пробои сейчас",
        "/news [AAPL] — свежие новости и дайджест ИИ",
        "/quote AAPL — котировка",
        "/buy AAPL 1 — купить",
        "/sell AAPL 1 — продать",
        "/journal — журнал за 7 дней",
        "/menu — показать кнопки меню",
        "/version — версия бота",
        "",
        "Также можно написать любой вопрос текстом (например: «Что сегодня по NVDA?»).",
      ].join("\n"),
      mainMenuKeyboard(),
    );
  }

  async function handleAccount(ctx) {
    const account = await alpaca.getAccount();
    await ctx.reply(
      [
        `Equity: ${formatMoney(account.equity)}`,
        `Cash: ${formatMoney(account.cash)}`,
        `Buying power: ${formatMoney(account.buying_power)}`,
        `Status: ${account.status}`,
      ].join("\n"),
    );
  }

  async function handlePositions(ctx) {
    const positions = await alpaca.getPositions();

    if (positions.length === 0) {
      await ctx.reply("Открытых позиций нет.");
      return;
    }

    const lines = positions.map((position) => {
      const qty = Number(position.qty);
      const side = qty < 0 ? "short" : "long";
      return `${position.symbol} ${side} ${position.qty} @ ${formatMoney(position.avg_entry_price)}  PnL ${formatMoney(position.unrealized_pl)}`;
    });

    await ctx.reply(lines.join("\n"));
  }

  async function handleScan(ctx) {
    await ctx.reply(await desk.scanNow());
  }

  async function handlePlan(ctx) {
    await ctx.reply(await desk.planText());
  }

  async function handleJournal(ctx) {
    await ctx.reply(await desk.journalText());
  }

  async function handleNews(ctx, rawInput = "") {
    await ctx.sendChatAction?.("typing").catch(() => {});
    await ctx.reply(await desk.newsDigest(rawInput));
  }

  bot.start(sendStartMenu);
  bot.command("menu", sendStartMenu);

  bot.command("account", handleAccount);
  bot.hears(MENU_BUTTONS.ACCOUNT, handleAccount);

  bot.command("positions", handlePositions);
  bot.hears(MENU_BUTTONS.POSITIONS, handlePositions);

  bot.command("quote", async (ctx) => {
    const symbol = parseQuoteSymbol(ctx.message.text);

    if (!symbol) {
      await ctx.reply("Формат: /quote AAPL");
      return;
    }

    const payload = await alpaca.getLatestQuote(symbol);
    const quote = payload?.quote;

    if (!quote) {
      await ctx.reply(`Нет котировки для ${symbol}.`);
      return;
    }

    await ctx.reply(
      [
        symbol,
        `Bid ${formatMoney(quote.bp)} x ${quote.bs}`,
        `Ask ${formatMoney(quote.ap)} x ${quote.as}`,
      ].join("\n"),
    );
  });

  bot.command("buy", (ctx) => requestOrder(ctx, "buy"));
  bot.command("sell", (ctx) => requestOrder(ctx, "sell"));

  bot.command("scan", handleScan);
  bot.hears(MENU_BUTTONS.SCAN, handleScan);

  bot.command("plan", handlePlan);
  bot.hears(MENU_BUTTONS.PLAN, handlePlan);

  bot.command("journal", handleJournal);
  bot.hears(MENU_BUTTONS.JOURNAL, handleJournal);

  bot.command("news", (ctx) => handleNews(ctx, ctx.message.text));
  bot.hears(MENU_BUTTONS.NEWS, (ctx) => handleNews(ctx, ""));

  bot.command("version", (ctx) =>
    ctx.reply(`stock-analiz ${APP_VERSION}\nPaper Alpaca, Telegram-бот.`),
  );

  bot.on("text", async (ctx) => {
    const text = ctx.message?.text?.trim() ?? "";

    if (!text) {
      return;
    }

    if (text.startsWith("/")) {
      await ctx.reply("Неизвестная команда. Нажмите /menu для списка команд.");
      return;
    }

    await ctx.sendChatAction?.("typing").catch(() => {});
    const answer = await desk.askAssistant(text);
    await ctx.reply(answer);
  });

  bot.action(/^order:confirm:(.+)$/, async (ctx) => {
    const pending = pendingOrders.get(ctx.from.id);

    if (!pending || pending.id !== ctx.match[1]) {
      await ctx.answerCbQuery("Нет ордера в ожидании.");
      return;
    }

    pendingOrders.delete(ctx.from.id);
    const { symbol, qty, side } = pending;
    const order = await alpaca.submitMarketOrder({ symbol, qty, side });

    await ctx.editMessageText(
      `Ордер ${order.side} ${order.qty} ${order.symbol} отправлен. Статус: ${order.status}.`,
    );
    await ctx.answerCbQuery("Отправлено");
  });

  bot.action(/^order:cancel:(.+)$/, async (ctx) => {
    const pending = pendingOrders.get(ctx.from.id);

    if (pending?.id === ctx.match[1]) {
      pendingOrders.delete(ctx.from.id);
    }

    await ctx.editMessageText("Ордер отменён.");
    await ctx.answerCbQuery("Отменено");
  });

  bot.action(/^plan:buy:(\d{4}-\d{2}-\d{2}):([A-Z.]{1,10})$/, async (ctx) => {
    const result = await desk.buyIdea({
      date: ctx.match[1],
      symbol: ctx.match[2],
    });
    await ctx.answerCbQuery(result.ok ? "Отправлено" : "Не отправлено");
    await ctx.reply(result.text);
  });

  bot.action(/^plan:sell:(\d{4}-\d{2}-\d{2}):([A-Z.]{1,10})$/, async (ctx) => {
    const result = await desk.sellIdea({
      date: ctx.match[1],
      symbol: ctx.match[2],
    });
    await ctx.answerCbQuery(result.ok ? "Закрыто" : "Не закрыто");
    await ctx.reply(result.text);
  });

  bot.action(/^plan:cover:(\d{4}-\d{2}-\d{2}):([A-Z.]{1,10})$/, async (ctx) => {
    const result = await desk.coverShort({
      date: ctx.match[1],
      symbol: ctx.match[2],
    });
    await ctx.answerCbQuery(result.ok ? "Закрываю" : "Нет шорта");
    await ctx.reply(result.text);
  });

  bot.catch((error, ctx) => {
    console.error(error);
    ctx.reply(`Ошибка: ${error.message}`).catch(() => {});
  });

  return bot;
}

async function requestOrder(ctx, side) {
  const parsed = parseOrderArgs(ctx.message.text);

  if (!parsed) {
    await ctx.reply(`Формат: /${side} AAPL 1`);
    return;
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  pendingOrders.set(ctx.from.id, { ...parsed, side, id });

  await ctx.reply(
    `Подтвердите рыночный ${side} ${parsed.qty} ${parsed.symbol} (day, paper).`,
    Markup.inlineKeyboard([
      Markup.button.callback("Подтвердить", `order:confirm:${id}`),
      Markup.button.callback("Отмена", `order:cancel:${id}`),
    ]),
  );
}
