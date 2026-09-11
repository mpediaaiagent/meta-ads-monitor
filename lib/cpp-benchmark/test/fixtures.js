// Builders for synthetic ads. Tests describe ads by their cumulative numbers, which is what the
// rules are written in; these derive the raw daily rows the module actually receives.

const DAY_MS = 86_400_000;

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Raw daily rows from cumulative [spend, purchases] per day, day 1 first. */
export function dailyFromCumulative(cumulative, startDate = "2026-08-01") {
  let prevSpend = 0;
  let prevPurchases = 0;
  return cumulative.map(([cumSpend, cumPurchases], i) => {
    const row = { date: addDays(startDate, i), spend: round2(cumSpend - prevSpend), purchases: cumPurchases - prevPurchases };
    prevSpend = cumSpend;
    prevPurchases = cumPurchases;
    return row;
  });
}

/** Raw daily rows for an ad whose cumulative CPP on day i is cpps[i], with purchases[i] purchases by then. */
export function dailyWithCpp(cpps, purchases) {
  return dailyFromCumulative(cpps.map((cpp, i) => [cpp * purchases[i], purchases[i]]));
}

/** A successful ad for buildBenchmarks. */
export function ad(adId, campaignName, daily) {
  return { adId, campaignName, daily };
}

/** Two purchases a day. */
export const RAMP = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22];

/** Spends ₹100 a day for `days` days with no purchase. */
export function flatSpend(days, perDay = 100, startDate = "2026-08-01") {
  return Array.from({ length: days }, (_, i) => ({ date: addDays(startDate, i), spend: perDay, purchases: 0 }));
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
