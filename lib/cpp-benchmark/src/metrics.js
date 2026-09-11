// How a day's cumulative numbers are read. Kept in one place so the cohort's ceilings and the ad
// being judged are always measured by the same rule.

/** True cumulative CPP, or null before the first purchase — it is undefined then, not 0 or ∞. */
export function cumulativeCpp(day) {
  return day.cumPurchases > 0 ? day.cumSpend / day.cumPurchases : null;
}

/**
 * The CPP used for every comparison. Before the first purchase this is cumSpend: what the CPP
 * would be if a purchase landed right now, i.e. the best it can still turn out. An ad that has
 * already spent past the ceiling without converting therefore reads as outside, while one still
 * under it isn't condemned merely for not having converted yet. Cohort ads' early zero-purchase
 * days are read the same way, so a successful ad that started slowly widens the early ceiling.
 */
export function comparableCpp(day) {
  return day.cumSpend / Math.max(day.cumPurchases, 1);
}

/** The minimum-data floor: enough spend OR enough purchases, whichever comes first. */
export function passesFloor(day, floor) {
  return day.cumSpend >= floor.minCumSpend || day.cumPurchases >= floor.minCumPurchases;
}
