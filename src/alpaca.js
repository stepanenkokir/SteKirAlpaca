const TRADING_URL = "https://paper-api.alpaca.markets";
const DATA_URL = "https://data.alpaca.markets";

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
      throw new Error(message);
    }

    return body;
  }

  return {
    getAccount() {
      return request(TRADING_URL, "/v2/account");
    },

    getPositions() {
      return request(TRADING_URL, "/v2/positions");
    },

    getLatestQuote(symbol) {
      return request(
        DATA_URL,
        `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=iex`,
      );
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
  };
}
