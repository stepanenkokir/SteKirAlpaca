const TRADING_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";

export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isNotFound(error) {
  return error?.status === 404;
}

export function isRateLimited(error) {
  return error?.status === 429;
}

export function createAlpacaClient({ alpacaApiKey, alpacaSecretKey }) {
  const headers = {
    "APCA-API-KEY-ID": alpacaApiKey,
    "APCA-API-SECRET-KEY": alpacaSecretKey,
  };

  async function request(baseUrl, path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        ...headers,
        ...options.headers,
      },
    });

    const text = await response.text();
    let body = null;

    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }

    if (!response.ok) {
      const message = body?.message || text || response.statusText;
      throw new HttpError(message, response.status);
    }

    return body;
  }

  async function getStockBars({ symbols, timeframe, start, end, limit = 10000 }) {
    const bars = {};
    let pageToken = null;

    do {
      const params = new URLSearchParams({
        symbols: symbols.join(","),
        timeframe,
        start,
        end,
        feed: "iex",
        limit: String(limit),
        adjustment: "raw",
        sort: "asc",
      });

      if (pageToken) {
        params.set("page_token", pageToken);
      }

      const payload = await request(DATA_URL, `/v2/stocks/bars?${params}`);

      for (const [symbol, list] of Object.entries(payload.bars ?? {})) {
        bars[symbol] = (bars[symbol] ?? []).concat(list);
      }

      pageToken = payload.next_page_token ?? null;
    } while (pageToken);

    return bars;
  }

  return {
    getAccount() {
      return request(TRADING_URL, "/v2/account");
    },

    getAccountConfigurations() {
      return request(TRADING_URL, "/v2/account/configurations");
    },

    getClock() {
      return request(TRADING_URL, "/v2/clock");
    },

    getCalendar({ start, end }) {
      const params = new URLSearchParams({ start, end });
      return request(TRADING_URL, `/v2/calendar?${params}`);
    },

    getPositions() {
      return request(TRADING_URL, "/v2/positions");
    },

    getPosition(symbol) {
      return request(
        TRADING_URL,
        `/v2/positions/${encodeURIComponent(symbol)}`,
      );
    },

    closePosition(symbol) {
      return request(
        TRADING_URL,
        `/v2/positions/${encodeURIComponent(symbol)}`,
        { method: "DELETE" },
      );
    },

    getLatestQuote(symbol) {
      return request(
        DATA_URL,
        `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`,
      );
    },

    getLatestQuotes(symbols) {
      const params = new URLSearchParams({
        symbols: symbols.join(","),
        feed: "iex",
      });
      return request(DATA_URL, `/v2/stocks/quotes/latest?${params}`);
    },

    getStockBars,

    getNews({ symbols, start, limit = 5 }) {
      const params = new URLSearchParams({
        symbols: symbols.join(","),
        limit: String(limit),
        sort: "desc",
      });

      if (start) {
        params.set("start", start);
      }

      return request(DATA_URL, `/v1beta1/news?${params}`);
    },

    getOrder(id, { nested = true } = {}) {
      const params = new URLSearchParams({ nested: String(nested) });
      return request(TRADING_URL, `/v2/orders/${id}?${params}`);
    },

    getOrders({ nested = true, status = "all", symbols } = {}) {
      const params = new URLSearchParams({
        nested: String(nested),
        status,
      });

      if (symbols?.length) {
        params.set("symbols", symbols.join(","));
      }

      return request(TRADING_URL, `/v2/orders?${params}`);
    },

    submitMarketOrder({ symbol, qty, side }) {
      return request(TRADING_URL, "/v2/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          qty: String(qty),
          side,
          type: "market",
          time_in_force: "day",
        }),
      });
    },

    submitBracketOrder({ symbol, qty, limitPrice, takeProfit, stopPrice }) {
      return request(TRADING_URL, "/v2/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          qty: String(qty),
          side: "buy",
          type: "limit",
          limit_price: String(limitPrice),
          time_in_force: "day",
          order_class: "bracket",
          take_profit: { limit_price: String(takeProfit) },
          stop_loss: { stop_price: String(stopPrice) },
        }),
      });
    },

    replaceOrder(id, { limitPrice, stopPrice, qty } = {}) {
      const body = {};

      if (limitPrice != null) {
        body.limit_price = String(limitPrice);
      }

      if (stopPrice != null) {
        body.stop_price = String(stopPrice);
      }

      if (qty != null) {
        body.qty = String(qty);
      }

      return request(TRADING_URL, `/v2/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },

    cancelOrder(id) {
      return request(TRADING_URL, `/v2/orders/${id}`, { method: "DELETE" });
    },
  };
}
