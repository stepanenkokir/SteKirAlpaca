export function summarizeEvents(events) {
  const signals = events.filter((event) => event.type === "signal");
  const taken = events.filter(
    (event) => event.type === "decision" && event.action === "bought",
  );
  const exits = events.filter((event) => event.type === "exit");
  const rs = exits.map((event) => Number(event.r)).filter(Number.isFinite);
  const wins = rs.filter((value) => value > 0).length;
  let maxLossStreak = 0;
  let current = 0;

  for (const value of rs) {
    if (value <= 0) {
      current += 1;
      maxLossStreak = Math.max(maxLossStreak, current);
    } else {
      current = 0;
    }
  }

  return {
    signals: signals.length,
    taken: taken.length,
    exits: exits.length,
    winRate: rs.length ? wins / rs.length : 0,
    avgR: rs.length ? rs.reduce((sum, value) => sum + value, 0) / rs.length : 0,
    maxLossStreak,
    filters: countFilters(events),
  };
}

export function formatSummary(summary) {
  const filters = Object.entries(summary.filters ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");

  return [
    `Сигналов: ${summary.signals}`,
    `Взято: ${summary.taken}`,
    `Выходов: ${summary.exits}`,
    `Доля прибыльных: ${pct(summary.winRate)}`,
    `Средний R: ${summary.avgR.toFixed(2)}`,
    `Макс. серия убытков: ${summary.maxLossStreak}`,
    filters ? `Фильтры: ${filters}` : "Фильтры: нет",
  ].join("\n");
}

export function eventsSince(events, since) {
  const start = since.getTime();
  return events.filter((event) => {
    const ts = Date.parse(event.ts ?? "");
    return Number.isFinite(ts) && ts >= start;
  });
}

function countFilters(events) {
  const filters = {};

  for (const event of events) {
    if (event.type !== "filter") {
      continue;
    }

    filters[event.reason] = (filters[event.reason] ?? 0) + 1;
  }

  return filters;
}

function pct(value) {
  return `${(value * 100).toFixed(0)}%`;
}
