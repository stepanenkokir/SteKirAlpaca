const DEFAULT_WATCHLIST = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AMD",
  "NFLX",
  "AVGO",
  "JPM",
  "BAC",
  "XOM",
  "UNH",
  "COST",
  "CRM",
  "ORCL",
  "ADBE",
  "QCOM",
  "INTC",
];

const required = [
  "ALPACA_API_KEY",
  "ALPACA_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
  "OPENAI_API_KEY",
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
    openaiApiKey: process.env.OPENAI_API_KEY.trim(),
    openaiModel: optionalString("OPENAI_MODEL", "gpt-4.1-mini"),
    watchlist: parseWatchlist(process.env.WATCHLIST),
    riskFraction: optionalNumber("RISK_FRACTION", 0.005),
    maxPositionFraction: optionalNumber("MAX_POSITION_FRACTION", 0.25),
    rvolMin: optionalNumber("RVOL_MIN", 1.1),
    maxRangePct: optionalNumber("MAX_RANGE_PCT", 0.025),
    entryBufferPct: optionalNumber("ENTRY_BUFFER_PCT", 0.001),
    autoFlatten: optionalBoolean("AUTO_FLATTEN", true),
  };
}

export { DEFAULT_WATCHLIST };

function parseWatchlist(value) {
  if (!value?.trim()) {
    return [...DEFAULT_WATCHLIST];
  }

  const symbols = value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^[A-Z.]{1,10}$/.test(item));

  if (symbols.length === 0) {
    throw new Error("WATCHLIST must contain at least one ticker");
  }

  return [...new Set(symbols)];
}

function optionalString(key, fallback) {
  const value = process.env[key]?.trim();
  return value || fallback;
}

function optionalNumber(key, fallback) {
  const raw = process.env[key]?.trim();

  if (!raw) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`);
  }

  return value;
}

function optionalBoolean(key, fallback) {
  const raw = process.env[key]?.trim().toLowerCase();

  if (!raw) {
    return fallback;
  }

  if (raw === "true" || raw === "1") {
    return true;
  }

  if (raw === "false" || raw === "0") {
    return false;
  }

  throw new Error(`${key} must be true or false`);
}
