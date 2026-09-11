import { BENCHMARK_KIND, REASON, STATUS, VERDICT } from "./constants.js";
import { resolveConfig } from "./config.js";
import { alignFromFirstSpend } from "./history.js";

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
 * One day's verdict. With no purchase yet there is no CPP, so only the first-purchase limit can
 * apply; once an ad has a purchase, only the CPP benchmark does. (Judging a converted ad on its
 * pre-purchase spend would leave it on Pause forever, however good its CPP became.)
 */
export function judgeDay(d, benchmark, cfg) {
  const record = {
    day: d.day,
    date: d.date,
    cumSpend: d.cumSpend,
    cumPurchases: d.cumPurchases,
    cumCpp: d.cumPurchases > 0 ? round2(d.cumSpend / d.cumPurchases) : null,
  };

  if (d.cumPurchases === 0) {
    const limit = benchmark?.firstPurchaseLimit?.value ?? null;
    const detail = { kind: BENCHMARK_KIND.FIRST_PURCHASE_LIMIT, limit, sampleSize: benchmark?.firstPurchaseLimit?.sampleSize ?? 0 };
    if (limit === null) return { ...record, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK, benchmark: detail };
    const pause = above(d.cumSpend, limit);
    return {
      ...record,
      verdict: pause ? VERDICT.PAUSE : VERDICT.KEEP,
      reason: pause ? REASON.SPEND_WITHOUT_PURCHASE : REASON.WITHIN_FIRST_PURCHASE_LIMIT,
      benchmark: detail,
    };
  }

  const point = benchmark?.days?.[d.day - 1] ?? null;
  const detail = {
    kind: BENCHMARK_KIND.CPP,
    ceiling: point?.ceiling ?? null,
    margin: point?.margin ?? cfg.cppMargin,
    upperBound: point?.upperBound ?? null,
    sampleSize: point?.sampleSize ?? 0,
  };
  if (detail.upperBound === null) return { ...record, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK, benchmark: detail };
  const pause = above(d.cumSpend / d.cumPurchases, detail.upperBound);
  return {
    ...record,
    verdict: pause ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: pause ? REASON.CPP_ABOVE_BENCHMARK : REASON.WITHIN_CPP_BENCHMARK,
    benchmark: detail,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
