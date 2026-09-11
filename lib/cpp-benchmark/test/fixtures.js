// Builders for synthetic ad histories. Tests describe ads by their cumulative numbers, which is
// what the rules are written in, and these derive the daily fields from them.

const DAY_MS = 86_400_000;

export function addDays(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Daily rows for one ad from its cumulative [spend, purchases] per day, day 1 first. */
export function adRows(adId, product, cumulative, startDate = "2026-08-01") {
  let prevSpend = 0;
  let prevPurchases = 0;
  return cumulative.map(([cumSpend, cumPurchases], i) => {
    const row = {
      adId,
      product,
      date: addDays(startDate, i),
      ageDays: i + 1,
      spend: cumSpend - prevSpend,
      purchases: cumPurchases - prevPurchases,
      cumSpend,
      cumPurchases,
      cumCpp: cumPurchases > 0 ? cumSpend / cumPurchases : null,
    };
    prevSpend = cumSpend;
    prevPurchases = cumPurchases;
    return row;
  });
}

/** Two purchases a day: 20 by day 10, clearing the 17-purchase goal. */
export const RAMP = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24];

/** Rows for an ad whose cumulative CPP on each day is exactly cpps[i]. */
export function adWithCpp(adId, product, cpps, purchases = RAMP) {
  return adRows(adId, product, cpps.map((cpp, i) => [cpp * purchases[i], purchases[i]]));
}

// A three-ad mpedia cohort. All three finish day 10 at <= 280 with 20 purchases, so the max
// ceiling per day is the highest of the three paths:
//   day:      1    2    3    4    5    6    7    8    9    10
//   ceiling: 350  320  300  290  280  275  275  275  275  275
export const MPEDIA_COHORT = [
  ...adWithCpp("A", "mpedia", [300, 290, 280, 270, 260, 250, 250, 250, 250, 250]),
  ...adWithCpp("B", "mpedia", [350, 320, 300, 290, 280, 270, 265, 260, 255, 250]),
  ...adWithCpp("C", "mpedia", [250, 260, 270, 275, 275, 275, 275, 275, 275, 275]),
];

export const MPEDIA_CEILINGS = [350, 320, 300, 290, 280, 275, 275, 275, 275, 275];
