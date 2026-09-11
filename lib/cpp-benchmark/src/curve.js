import { CONFIDENCE, SCHEMA_VERSION } from "./constants.js";
import { resolveConfig } from "./config.js";
import { groupHistories } from "./input.js";
import { comparableCpp } from "./metrics.js";

/**
 * Builds every product's benchmark curve from daily rows. The result depends only on its inputs
 * (nothing is cached or kept between calls), so refreshing it as new ads join the successful cohort
 * is just a matter of calling it again with the latest history.
 */
export function buildBenchmarkCurves(rows, options) {
  const cfg = resolveConfig(options);
  return curvesFromHistories(groupHistories(rows, cfg), cfg);
}

/** Same as buildBenchmarkCurves, for histories that are already validated and grouped. */
export function curvesFromHistories(histories, cfg) {
  const products = {};
  for (const [product, goal] of Object.entries(cfg.goals)) {
    // Each product sees only its own ads, and there is deliberately no cross-product fallback:
    // educator program (700/1) can never borrow from or lend to the 280/17 products.
    const own = histories.filter((h) => h.product === product);
    products[product] = productCurve(product, goal, own, cfg);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    horizonDays: cfg.horizonDays,
    ceilingStatistic: cfg.ceilingStatistic.name,
    minCohortSize: cfg.minCohortSize,
    products,
  };
}

/** Did the ad meet its product's goal on this day? (cumulative CPP <= maxCpp AND purchases >= minPurchases) */
export function meetsGoal(day, goal) {
  return day.cumPurchases >= goal.minPurchases && day.cumSpend / day.cumPurchases <= goal.maxCpp;
}

/** Margin over the ceiling on a given day: explicit steps if configured, else a linear taper. */
export function marginForDay(day, margin) {
  if (margin.steps) return day <= margin.steps.length ? margin.steps[day - 1] : margin.standard;
  if (day > margin.taperDays) return margin.standard;
  return margin.earlyStart - ((margin.earlyStart - margin.standard) * (day - 1)) / margin.taperDays;
}

function productCurve(product, goal, histories, cfg) {
  const H = cfg.horizonDays;
  // Histories are validated to run day 1, 2, 3… without gaps, so days[H - 1] is day H.
  const cohort = histories.filter((h) => h.days.length >= H && meetsGoal(h.days[H - 1], goal));

  const days = [];
  for (let day = 1; day <= H; day++) {
    const sample = cohort.map((h) => comparableCpp(h.days[day - 1]));
    const margin = marginForDay(day, cfg.margin);
    const enough = sample.length >= cfg.minCohortSize;
    const ceiling = enough ? cfg.ceilingStatistic.compute(sample) : null;
    days.push({
      day,
      sampleSize: sample.length,
      confidence: enough ? CONFIDENCE.OK : CONFIDENCE.LOW,
      ceiling,
      margin,
      upperBound: ceiling === null ? null : ceiling * (1 + margin),
    });
  }

  return {
    product,
    goal: { ...goal },
    cohortSize: cohort.length,
    cohortAdIds: cohort.map((h) => h.adId),
    days,
  };
}
