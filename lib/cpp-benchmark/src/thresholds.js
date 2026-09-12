import { REASON, VERDICT } from "./constants.js";

/**
 * The per-product day-wise threshold schedule: the "campaign threshold" that can rescue an adset
 * the 3-month benchmark has flagged. See DEFAULT_DAY_THRESHOLDS in config.js for the numbers.
 */

/**
 * Cost per purchase, with the rule that **spend counts as the CPP when nothing has been bought**.
 * An adset that has spent ₹900 for no purchases is treated as ₹900 per purchase, not as having no
 * CPP at all — otherwise the worst case of all reads as "no data" and slips through every ceiling.
 *
 * @returns {number|null} null only when there has been no spend either
 */
export function effectiveCpp(cumSpend, cumPurchases) {
  const spend = Number(cumSpend) || 0;
  const purchases = Number(cumPurchases) || 0;
  if (purchases > 0) return round2(spend / purchases);
  return spend > 0 ? round2(spend) : null;
}

/**
 * The checkpoint in force on `day`: the latest one at or before it. Below the first checkpoint
 * there is none, so a brand-new adset has nothing to be measured against.
 *
 * @param {{day: number, maxCpp?: number, minPurchases?: number}[]|null} schedule
 * @returns {{day: number, maxCpp?: number, minPurchases?: number}|null}
 */
export function thresholdForDay(schedule, day) {
  if (!Array.isArray(schedule) || !schedule.length) return null;
  let hit = null;
  for (const step of schedule) {
    if (step.day <= day) hit = step;
    else break;
  }
  return hit;
}

// A value sitting exactly on a limit is not above it; this absorbs float noise at that boundary.
const EPSILON = 1e-9;
const above = (value, limit) => value > limit + EPSILON * Math.max(1, Math.abs(limit));

/**
 * Is this day's performance inside the product's own threshold? Used to rescue something the
 * 3-month benchmark flagged: within the threshold means Keep, whatever the benchmark said.
 *
 * @param {{day: number, cumSpend: number, cumPurchases: number}} d
 * @param {{day: number, maxCpp?: number, minPurchases?: number}[]|null} schedule
 * @returns {{
 *   checked: boolean, notChecked: string|null,
 *   day: number, checkpointDay: number|null, kind: "cpp"|"purchases"|null,
 *   limit: number|null, cpp: number|null, cumSpend: number, cumPurchases: number,
 *   verdict: "Keep"|"Pause"|null, reason: string|null
 * }}
 */
export function judgeProductThreshold(d, schedule) {
  const base = {
    checked: false, notChecked: null,
    day: d.day, checkpointDay: null, kind: null, limit: null,
    cpp: effectiveCpp(d.cumSpend, d.cumPurchases),
    cumSpend: d.cumSpend, cumPurchases: d.cumPurchases,
    verdict: null, reason: null,
  };

  const step = thresholdForDay(schedule, d.day);
  if (!step) return { ...base, notChecked: schedule?.length ? "before_first_checkpoint" : "no_schedule" };

  if (step.minPurchases != null) {
    const ok = d.cumPurchases >= step.minPurchases;
    return {
      ...base,
      checked: true,
      checkpointDay: step.day,
      kind: "purchases",
      limit: step.minPurchases,
      verdict: ok ? VERDICT.KEEP : VERDICT.PAUSE,
      reason: ok ? REASON.WITHIN_PRODUCT_THRESHOLD : REASON.ABOVE_PRODUCT_THRESHOLD,
    };
  }

  // no purchase yet means the spend itself is the CPP, so this still has something to compare
  if (base.cpp === null) return { ...base, notChecked: "no_spend" };
  const ok = !above(base.cpp, step.maxCpp);
  return {
    ...base,
    checked: true,
    checkpointDay: step.day,
    kind: "cpp",
    limit: step.maxCpp,
    verdict: ok ? VERDICT.KEEP : VERDICT.PAUSE,
    reason: ok ? REASON.WITHIN_PRODUCT_THRESHOLD : REASON.ABOVE_PRODUCT_THRESHOLD,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
