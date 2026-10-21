export function formatMoney(value) {
  const amount = Number(value);

  if (Number.isNaN(amount)) {
    return String(value);
  }

  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function formatPct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

export function formatRvol(value) {
  return `${Number(value).toFixed(2)}×`;
}
