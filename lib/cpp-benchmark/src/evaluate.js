import { BENCHMARK_KIND, REASON, STATUS, VERDICT } from "./constants.js";
import { resolveConfig } from "./config.js";
import { alignFromFirstSpend } from "./history.js";
import { effectiveCpp } from "./thresholds.js";

/**
 * Keep/Pause for one ad, day by day through its incubation window.
 *
 * @param {{date: string, spend: number, purchases: number}[]} daily  the ad's raw daily rows from
 *   its first day onward (earlier zero rows are fine and ignored).
 * @param {object|null} benchmark  this ad's product entry from buildBenchmarks(...).products; null
 *   when there is none, which makes every day Keep with reason no_benchmark.
 * @param {object} [options]  `through`: last date of the data window, so days without delivery at
 *   the end still count towards age. Other keys override DEFAULT_CONFIG.
 *
 * @returns {{
 *   status: "incubation"|"past_incubation"|"not_started",
 *   ageDays: number, firstSpendDate: string|null,
 *   verdict: "Keep"|"Pause"|null, reason: string|null,   // the latest day's; null unless status is incubation
 *   days: DayVerdict[]                                   // days 1..min(age, incubationMaxDay)
 * }}
 *
 * @typedef {{
 *   day: number, date: string, cumSpend: number, cumPurchases: number, cumCpp: number|null,
 *   verdict: "Keep"|"Pause", reason: string,
 *   benchmark: {kind: "cpp", ceiling: number|null, margin: number, upperBound: number|null, sampleSize: number}
 *            | {kind: "first_purchase_limit", limit: number|null, sampleSize: number}
 * }} DayVerdict
 */
export function evaluateAd(daily, benchmark, options = {}) {
  const { through, ...overrides } = options;
  const cfg = resolveConfig(overrides);
  const days = alignFromFirstSpend(daily, { through });
  if (!days) return { status: STATUS.NOT_STARTED, ageDays: 0, firstSpendDate: null, verdict: null, reason: null, days: [] };

  const judged = days.slice(0, cfg.incubationMaxDay).map((d) => judgeDay(d, benchmark, cfg));
  const base = { ageDays: days.length, firstSpendDate: days[0].date };
  if (days.length > cfg.incubationMaxDay) {
    return { status: STATUS.PAST_INCUBATION, ...base, verdict: null, reason: null, days: judged };
  }
  const latest = judged[judged.length - 1];
  return { status: STATUS.INCUBATION, ...base, verdict: latest.verdict, reason: latest.reason, days: judged };
}

// A value sitting exactly on a limit is not above it; this absorbs float noise at that boundary.
const EPSILON = 1e-9;
const above = (value, limit) => value > limit + EPSILON * Math.max(1, Math.abs(limit));

/**
 * One day's verdict.
 *
 * The CPP is `effectiveCpp`: **with no purchase, the spend itself is the CPP**. So an unconverted
 * ad faces two lines rather than none — the first-purchase spend limit AND that day's CPP ceiling —
 * and is Pause if it is past either. Once it has a purchase only the CPP benchmark applies, because
 * judging a converted ad on its pre-purchase spend would leave it on Pause forever however good its
 * CPP became.
 */
export function judgeDay(d, benchmark, cfg) {
  const record = {
    day: d.day,
    date: d.date,
    cumSpend: d.cumSpend,
    cumPurchases: d.cumPurchases,
    cumCpp: effectiveCpp(d.cumSpend, d.cumPurchases),
  };

  // An ad's first day(s) never decide a verdict: one day of delivery is noise, and pausing on it
  // gives an ad no chance to settle. The day still appears in the grid, as a Keep.
  if (d.day <= cfg.adImmuneDays) {
    return { ...record, verdict: VERDICT.KEEP, reason: REASON.IMMUNE_EARLY_DAYS, benchmark: { kind: null, immuneThrough: cfg.adImmuneDays } };
  }

  const point = benchmark?.days?.[d.day - 1] ?? null;
  const cppDetail = {
    kind: BENCHMARK_KIND.CPP,
    ceiling: point?.ceiling ?? null,
    margin: point?.margin ?? cfg.cppMargin,
    upperBound: point?.upperBound ?? null,
    sampleSize: point?.sampleSize ?? 0,
  };
  const overCpp = cppDetail.upperBound !== null && record.cumCpp !== null && above(record.cumCpp, cppDetail.upperBound);

  if (d.cumPurchases === 0) {
    const limit = benchmark?.firstPurchaseLimit?.value ?? null;
    const fpDetail = { kind: BENCHMARK_KIND.FIRST_PURCHASE_LIMIT, limit, sampleSize: benchmark?.firstPurchaseLimit?.sampleSize ?? 0 };
    const overSpend = limit !== null && above(d.cumSpend, limit);
    if (limit === null && cppDetail.upperBound === null) {
      return { ...record, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK, benchmark: fpDetail };
    }
    // the spend limit is the more specific "never converted" signal, so it is named first
    if (overSpend) return { ...record, verdict: VERDICT.PAUSE, reason: REASON.SPEND_WITHOUT_PURCHASE, benchmark: fpDetail };
    if (overCpp) return { ...record, verdict: VERDICT.PAUSE, reason: REASON.CPP_ABOVE_BENCHMARK, benchmark: cppDetail };
    return {
      ...record,
      verdict: VERDICT.KEEP,
      reason: limit === null ? REASON.WITHIN_CPP_BENCHMARK : REASON.WITHIN_FIRST_PURCHASE_LIMIT,
      benchmark: limit === null ? cppDetail : fpDetail,
    };
  }

  if (cppDetail.upperBound === null) return { ...record, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK, benchmark: cppDetail };
  return {
    ...record,
    verdict: overCpp ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: overCpp ? REASON.CPP_ABOVE_BENCHMARK : REASON.WITHIN_CPP_BENCHMARK,
    benchmark: cppDetail,
  };
}

/**
 * Keep/Pause for an ad past incubation, from its totals over the 10-day window. There is no
 * per-day benchmark this late, so the product's threshold (the same number that decides which
 * ads are successful) is the line: Pause when window CPP is above it. With no purchase in the
 * window there is no CPP, so the first-purchase limit applies instead, as it does in incubation.
 * No margin on either.
 *
 * @param {{spend: number, purchases: number}} totals
 * @param {object|null} benchmark  the ad's product entry from buildBenchmarks (for its firstPurchaseLimit)
 * @param {number|null} maxCpp     the product's threshold; null → Keep / no_benchmark
 */
export function judgeWindow(totals, benchmark, maxCpp) {
  const spend = Number(totals?.spend) || 0;
  const purchases = Number(totals?.purchases) || 0;
  // with no purchase in the window, the window's spend is its CPP
  const cpp = effectiveCpp(spend, purchases);
  const base = { spend: round2(spend), purchases, cpp };
  const overThreshold = maxCpp != null && cpp !== null && above(cpp, maxCpp);

  if (purchases === 0) {
    const limit = benchmark?.firstPurchaseLimit?.value ?? null;
    const fpDetail = { kind: BENCHMARK_KIND.FIRST_PURCHASE_LIMIT, limit, sampleSize: benchmark?.firstPurchaseLimit?.sampleSize ?? 0 };
    const thrDetail = { kind: BENCHMARK_KIND.WINDOW_THRESHOLD, threshold: maxCpp ?? null };
    const overSpend = limit !== null && above(spend, limit);
    if (limit === null && maxCpp == null) return { ...base, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK, benchmark: fpDetail };
    if (overSpend) return { ...base, verdict: VERDICT.PAUSE, reason: REASON.SPEND_WITHOUT_PURCHASE, benchmark: fpDetail };
    if (overThreshold) return { ...base, verdict: VERDICT.PAUSE, reason: REASON.WINDOW_CPP_ABOVE_THRESHOLD, benchmark: thrDetail };
    return {
      ...base,
      verdict: VERDICT.KEEP,
      reason: limit === null ? REASON.WITHIN_WINDOW_THRESHOLD : REASON.WITHIN_FIRST_PURCHASE_LIMIT,
      benchmark: limit === null ? thrDetail : fpDetail,
    };
  }

  const detail = { kind: BENCHMARK_KIND.WINDOW_THRESHOLD, threshold: maxCpp ?? null };
  if (maxCpp == null) return { ...base, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK, benchmark: detail };
  return {
    ...base,
    verdict: overThreshold ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: overThreshold ? REASON.WINDOW_CPP_ABOVE_THRESHOLD : REASON.WITHIN_WINDOW_THRESHOLD,
    benchmark: detail,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
