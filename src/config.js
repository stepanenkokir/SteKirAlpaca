const required = [
  "ALPACA_API_KEY",
  "ALPACA_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
];

export function loadConfig() {
  const missing = required.filter((key) => !process.env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }

  const telegramAllowedUserId = Number(process.env.TELEGRAM_ALLOWED_USER_ID);

  if (!Number.isInteger(telegramAllowedUserId) || telegramAllowedUserId <= 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a positive integer");
  }

  return {
    alpacaApiKey: process.env.ALPACA_API_KEY.trim(),
    alpacaSecretKey: process.env.ALPACA_SECRET_KEY.trim(),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN.trim(),
    telegramAllowedUserId,
  };
}
