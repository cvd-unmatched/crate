// Money is kept as integer cents everywhere so splits and totals never drift.
// Shared by the browser (display) and the server (validation limits).

export const MAX_CENTS = 100_000_000; // 1,000,000.00

/**
 * Reads what people actually type: "12.50", "12,50", "€ 1.234,56", "1 234".
 * A single trailing separator followed by 1-2 digits is the decimal point;
 * every other separator is treated as a thousands separator.
 * Returns cents, null for an empty field, or NaN when it isn't an amount.
 */
export function parseMoney(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  if (text.includes('-')) return NaN;
  const core = text.replace(/^[^\d.,]+|[^\d.,]+$/g, '').replace(/[\s  ']/g, '');
  const match = core.match(/^([\d.,]*?)(?:[.,](\d{1,2}))?$/);
  if (!match) return NaN;
  const whole = match[1].replace(/[.,]/g, '');
  if (whole === '' && match[2] === undefined) return NaN;
  const cents = Number(whole || 0) * 100 + Number((match[2] ?? '0').padEnd(2, '0'));
  return cents <= MAX_CENTS ? cents : NaN;
}

/** Splits cents into n parts that add up exactly; leftover cents go to the first parts. */
export function splitEvenly(total, n) {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const remainder = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** A gift cost nothing, whatever price may have been typed before it was marked. */
export const paidOf = (item) => (item.gift ? 0 : item.paid);

/**
 * Derives every number the UI shows from the raw records and bundles.
 * A bundled record's shipping is its share of the bundle's shipping;
 * a standalone record uses its own shipping field.
 */
export function computeLedger(items, bundles) {
  const members = new Map();
  for (const item of items) {
    if (!item.bundleId || !bundles.has(item.bundleId)) continue;
    if (!members.has(item.bundleId)) members.set(item.bundleId, []);
    members.get(item.bundleId).push(item);
  }

  const shares = new Map();
  const bundleTotals = new Map();
  for (const [id, bundle] of bundles) {
    const list = (members.get(id) ?? []).sort((a, b) => Number(a.instanceId) - Number(b.instanceId));
    const split = splitEvenly(bundle.shipping ?? 0, list.length);
    list.forEach((item, i) => shares.set(item.instanceId, split[i]));
    bundleTotals.set(id, {
      items: list,
      records: list.reduce((sum, item) => sum + (paidOf(item) ?? 0), 0),
      unpriced: list.filter((item) => paidOf(item) == null).length,
      shipping: list.length ? (bundle.shipping ?? 0) : 0,
    });
  }

  const rows = new Map();
  const totals = { records: 0, shipping: 0, spent: 0, sold: 0, soldCount: 0, profit: 0, profitCount: 0, owned: 0, unpriced: 0, gifts: 0 };
  for (const item of items) {
    const paid = paidOf(item);
    const ship = shares.get(item.instanceId) ?? item.shipping ?? 0;
    const cost = paid == null ? null : paid + ship;
    const profit = item.sold != null && cost != null ? item.sold - cost : null;
    rows.set(item.instanceId, { ship, cost, profit });

    totals.records += paid ?? 0;
    totals.shipping += ship;
    if (item.gift) totals.gifts++;
    if (item.sold != null) {
      totals.sold += item.sold;
      totals.soldCount++;
    }
    if (profit != null) {
      totals.profit += profit;
      totals.profitCount++;
    }
    if (item.inCollection) {
      totals.owned++;
      if (paid == null) totals.unpriced++;
    }
  }
  totals.spent = totals.records + totals.shipping;

  return { rows, bundles: bundleTotals, totals };
}
