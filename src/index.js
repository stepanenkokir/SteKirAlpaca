import { createAlpacaClient } from "./alpaca.js";
import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { APP_VERSION } from "./version.js";

const config = loadConfig();
const alpaca = createAlpacaClient(config);
const bot = createBot({
  token: config.telegramBotToken,
  allowedUserId: config.telegramAllowedUserId,
  alpaca,
});

await bot.launch();
console.log(`Bot started v${APP_VERSION}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
