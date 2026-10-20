import { isNotFound } from "./alpaca.js";
import { isOpenOrderStatus } from "./market.js";

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function flattenPosition({
  alpaca,
  symbol,
  parentOrderId,
  sleep = delay,
  waitMs = 10_000,
}) {
  await cancelBracketGroup({ alpaca, parentOrderId, sleep, waitMs });

  let position = await getPositionOrNull(alpaca, symbol);

  if (position && Number(position.qty) !== 0) {
    await alpaca.closePosition(symbol);
    position = await getPositionOrNull(alpaca, symbol);
  }

  const qty = position ? Number(position.qty) : 0;
  return { short: qty < 0, qty };
}

export async function cancelBracketGroup({
  alpaca,
  parentOrderId,
  sleep = delay,
  waitMs = 10_000,
}) {
  if (!parentOrderId) {
    return;
  }

  const order = await getOrderOrNull(alpaca, parentOrderId);

  if (!order) {
    return;
  }

  const ids = cancelTargets(order);

  for (const id of ids) {
    try {
      await alpaca.cancelOrder(id);
    } catch (error) {
      if (!isNotFound(error) && !/already|filled/i.test(error.message ?? "")) {
        throw error;
      }
    }
  }

  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    const latest = await getOrderOrNull(alpaca, parentOrderId);

    if (!latest || !hasOpenLegs(latest)) {
      return;
    }

    await sleep(1000);
  }
}

export function cancelTargets(order) {
  if (isOpenOrderStatus(order.status)) {
    return [order.id];
  }

  return (order.legs ?? [])
    .filter((leg) => isOpenOrderStatus(leg.status))
    .map((leg) => leg.id);
}

function hasOpenLegs(order) {
  return [order, ...(order.legs ?? [])].some((item) => isOpenOrderStatus(item.status));
}

async function getOrderOrNull(alpaca, id) {
  try {
    return await alpaca.getOrder(id);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  }
}

async function getPositionOrNull(alpaca, symbol) {
  try {
    return await alpaca.getPosition(symbol);
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  }
}
