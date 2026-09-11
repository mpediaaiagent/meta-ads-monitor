// Turns an ad's raw daily rows into its life story, day 1 first. This is the one place "day 1" is
// defined, so the successful ads and the ads being judged are always counted the same way.

const DAY_MS = 86_400_000;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

/** Case-by-case match of a campaign name to one product; null when it matches none or several. */
export function classifyProduct(campaignName, cfg) {
  const name = String(campaignName ?? "");
  const hits = cfg.products.filter((p) => p.pattern.test(name));
  return hits.length === 1 ? hits[0].product : null;
}

/**
 * Raw daily rows → one entry per calendar day from the ad's first day with spend, with running
 * totals.
 *
 * @param {{date: string, spend: number, purchases: number}[]} daily  any order; a date with no row
 *   means the ad didn't deliver that day (Meta omits such days in some responses), so it counts as 0.
 * @param {{through?: string}} [opts]  last date to extend to (e.g. the end of the data window), so
 *   trailing days without delivery still count towards the ad's age. Defaults to the last row's date.
 * @returns {null | {day: number, date: string, spend: number, purchases: number, cumSpend: number, cumPurchases: number}[]}
 *   null when the ad never spent anything.
 */
export function alignFromFirstSpend(daily, opts = {}) {
  if (!Array.isArray(daily)) throw new InputError("daily must be an array of { date, spend, purchases }");
  const byDate = new Map();
  for (const row of daily) {
    const t = parseDay(row?.date);
    if (t === null) throw new InputError(`daily row has a bad date: ${JSON.stringify(row?.date)}`);
    if (!(Number.isFinite(row.spend) && row.spend >= 0)) throw new InputError(`daily row ${row.date}: spend must be a number >= 0`);
    if (!(Number.isFinite(row.purchases) && row.purchases >= 0)) throw new InputError(`daily row ${row.date}: purchases must be a number >= 0`);
    if (byDate.has(t)) throw new InputError(`daily has two rows for ${row.date}`);
    byDate.set(t, row);
  }

  const dates = [...byDate.keys()].sort((a, b) => a - b);
  const first = dates.find((t) => byDate.get(t).spend > 0);
  if (first === undefined) return null;

  let end = dates[dates.length - 1];
  if (opts.through !== undefined) {
    const through = parseDay(opts.through);
    if (through === null) throw new InputError(`through is not a YYYY-MM-DD date: ${JSON.stringify(opts.through)}`);
    end = Math.max(end, through);
  }

  const days = [];
  let cumSpend = 0;
  let cumPurchases = 0;
  for (let t = first, day = 1; t <= end; t += DAY_MS, day++) {
    const row = byDate.get(t);
    const spend = row ? row.spend : 0;
    const purchases = row ? row.purchases : 0;
    cumSpend += spend;
    cumPurchases += purchases;
    days.push({ day, date: formatDay(t), spend, purchases, cumSpend: round2(cumSpend), cumPurchases });
  }
  return days;
}

/** Did the ad spend on its day `successMinDays` or later? */
export function isSuccessful(days, cfg) {
  return Array.isArray(days) && days.some((d) => d.day >= cfg.successMinDays && d.spend > 0);
}

/** "YYYY-MM-DD" → UTC epoch ms, or null. Rejects impossible dates such as 2026-02-30. */
function parseDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return formatDay(ms) === s ? ms : null;
}

function formatDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Running money totals are kept to the paisa so float drift never decides a boundary case.
function round2(v) {
  return Math.round(v * 100) / 100;
}
