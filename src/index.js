import { createAlpacaClient } from "./alpaca.js";
import { BOT_COMMANDS, createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createDesk } from "./desk.js";
import { createOpenAiClient } from "./openai.js";
import { startScheduler } from "./scheduler.js";
import { createStore } from "./store.js";
import { APP_VERSION } from "./version.js";

const config = loadConfig();
const alpaca = createAlpacaClient(config);
const openai = createOpenAiClient({
  apiKey: config.openaiApiKey,
  model: config.openaiModel,
});
const store = createStore();
const notifier = {};
const desk = createDesk({ alpaca, openai, store, config, notifier });
const bot = createBot({
  token: config.telegramBotToken,
  allowedUserId: config.telegramAllowedUserId,
  alpaca,
  desk,
});

notifier.send = (text, extra) =>
  bot.telegram.sendMessage(config.telegramAllowedUserId, text, extra);

const stopScheduler = startScheduler(desk);

function shutdown(signal) {
  stopScheduler();
  bot.stop(signal);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

console.log(`Bot started v${APP_VERSION}`);

try {
  await bot.telegram.setMyCommands(BOT_COMMANDS).catch((error) => {
    console.warn("setMyCommands failed:", error.message);
  });
  await bot.telegram
    .setChatMenuButton({ menuButton: { type: "commands" } })
    .catch((error) => {
      console.warn("setChatMenuButton failed:", error.message);
    });
  await bot.launch();
} catch (error) {
  stopScheduler();
  throw error;
}
