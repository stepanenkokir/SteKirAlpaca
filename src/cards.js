import { formatMoney, formatPct, formatRvol } from "./format.js";

export function signalCardText(idea, { pdtNote, explanation } = {}) {
  const lines = [
    `${idea.symbol} — пробой диапазона открытия`,
    `Цена ${formatMoney(idea.lastClose)}  VWAP ${formatMoney(idea.vwap)}  RVOL ${formatRvol(idea.rvol)} (IEX)`,
    `Диапазон ${formatMoney(idea.rangeLow)}–${formatMoney(idea.rangeHigh)} (${formatPct(idea.rangePct)})`,
    `Вход ${formatMoney(idea.entryPrice)}  Стоп ${formatMoney(idea.stopPrice)}  Цель ${formatMoney(idea.targetPrice)}  Кол-во ${idea.qty}`,
    `Риск ${formatMoney(idea.riskDollars)}`,
  ];

  if (idea.headlines?.length) {
    lines.push("", "Новости:");
    lines.push(...idea.headlines.slice(0, 3).map((item) => `• ${item}`));
  }

  if (explanation?.thesis) {
    lines.push("", explanation.thesis);
  }

  if (explanation?.risk) {
    lines.push(explanation.risk);
  }

  lines.push("", "Объём и VWAP посчитаны по ленте IEX, это не вся биржа.");

  if (pdtNote) {
    lines.push(pdtNote);
  }

  return lines.join("\n");
}

export function buyKeyboard(date, symbol) {
  return inline([[button("Купить", `plan:buy:${date}:${symbol}`)]]);
}

export function sellKeyboard(date, symbol) {
  return inline([[button("Продать", `plan:sell:${date}:${symbol}`)]]);
}

export function coverKeyboard(date, symbol) {
  return inline([[button("Закрыть шорт", `plan:cover:${date}:${symbol}`)]]);
}

export function phaseLabel(phase) {
  return (
    {
      idle: "ожидание диапазона",
      scan: "поиск пробоя",
      watch: "сопровождение",
      flatten: "закрытие сессии",
    }[phase] ?? phase
  );
}

export function reasonLabel(reason) {
  return (
    {
      lost_vwap: "потерян VWAP",
      back_in_range: "возврат в диапазон",
      session_end: "близко закрытие сессии",
      auto_flatten: "автозакрытие перед концом сессии",
      manual: "ручной выход",
      stop_filled: "стоп",
      target_filled: "цель",
    }[reason] ?? reason
  );
}

function inline(rows) {
  return { reply_markup: { inline_keyboard: rows } };
}

function button(text, callback_data) {
  return { text, callback_data };
}
