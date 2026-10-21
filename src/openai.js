const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TIMEOUT_MS = 20_000;

const SIGNAL_SCHEMA = {
  name: "signal_card",
  strict: true,
  schema: {
    type: "object",
    properties: {
      thesis: { type: "string" },
      risk: { type: "string" },
    },
    required: ["thesis", "risk"],
    additionalProperties: false,
  },
};

const EXIT_SCHEMA = {
  name: "exit_card",
  strict: true,
  schema: {
    type: "object",
    properties: {
      thesis: { type: "string" },
      action: { type: "string" },
    },
    required: ["thesis", "action"],
    additionalProperties: false,
  },
};

export const FALLBACK_SIGNAL = {
  thesis:
    "Пробой диапазона открытия по правилам ORB. Объём и VWAP посчитаны по ленте IEX, это не вся биржа.",
  risk: "Стоп под диапазоном или не дальше 1.2% от входа. Цель 2R. Позиция не переносится на ночь.",
};

export const FALLBACK_EXIT = {
  thesis: "Правила сопровождения требуют выхода.",
  action: "Закрыть позицию кнопкой «Продать», пока стоп и цель ещё на бирже.",
};

export function createOpenAiClient({ apiKey, model }) {
  const samplingParams = /^(gpt-[56]|o\d)/i.test(model)
    ? { reasoning_effort: "none" }
    : { temperature: 0.2 };

  async function complete({ messages, schema }) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const payload = await requestJson({
          model,
          ...samplingParams,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: schema,
          },
        });
        const text = payload.choices?.[0]?.message?.content;

        if (!text) {
          throw new Error("Empty OpenAI response");
        }

        return JSON.parse(text);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async function requestJson(body) {
    const response = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: { message: text } };
      }
    }

    if (!response.ok) {
      throw new Error(payload?.error?.message || text || response.statusText);
    }

    return payload;
  }

  return {
    async explainSignal({ idea, headlines = [], news }) {
      const newsItems = (news ?? idea.news ?? headlines).slice(0, 5);
      const prompt = {
        symbol: idea.symbol,
        lastClose: idea.lastClose,
        rangeHigh: idea.rangeHigh,
        rangeLow: idea.rangeLow,
        vwap: idea.vwap,
        rvol: idea.rvol,
        stopPrice: idea.stopPrice,
        targetPrice: idea.targetPrice,
        qty: idea.qty,
        headlines: newsItems,
        note: "Цифры уже посчитаны кодом. Не предлагай другие цены. Пиши по-русски кратко.",
      };

      try {
        const result = await complete({
          schema: SIGNAL_SCHEMA,
          messages: [
            {
              role: "system",
              content:
                "Ты помощник внутридневного трейдера. Объясняешь уже посчитанный пробой диапазона открытия. Не меняй стоп, цель и количество. Не давай финансовых советов вне этих цифр.",
            },
            { role: "user", content: JSON.stringify(prompt) },
          ],
        });
        return {
          thesis: String(result.thesis ?? FALLBACK_SIGNAL.thesis),
          risk: String(result.risk ?? FALLBACK_SIGNAL.risk),
          prompt,
          raw: result,
        };
      } catch {
        return { ...FALLBACK_SIGNAL, prompt, raw: null };
      }
    },

    async explainExit({ idea, reason }) {
      const prompt = {
        symbol: idea.symbol,
        reason,
        lastClose: idea.lastClose,
        vwap: idea.vwap,
        rangeHigh: idea.rangeHigh,
        filledAvgPrice: idea.filledAvgPrice,
        note: "Две короткие фразы по-русски. Код причины уже выбран правилами.",
      };

      try {
        const result = await complete({
          schema: EXIT_SCHEMA,
          messages: [
            {
              role: "system",
              content:
                "Объясни сигнал к продаже по коду причины. Не предлагай держать позицию. Пиши по-русски.",
            },
            { role: "user", content: JSON.stringify(prompt) },
          ],
        });
        return {
          thesis: String(result.thesis ?? FALLBACK_EXIT.thesis),
          action: String(result.action ?? FALLBACK_EXIT.action),
          prompt,
          raw: result,
        };
      } catch {
        return { ...FALLBACK_EXIT, prompt, raw: null };
      }
    },
  };
}
