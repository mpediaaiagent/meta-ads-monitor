import { REASON, VERDICT } from "./constants.js";
import { alignFromFirstSpend } from "./history.js";

// A value sitting exactly on a limit is not above it; this absorbs float noise at that boundary.
const EPSILON = 1e-9;
const above = (value, limit) => value > limit + EPSILON * Math.max(1, Math.abs(limit));

/**
 * The whole adset's cumulative CPP on its latest day, against what past adsets of the same product
 * had on that day (buildAdsetBenchmarks). Pause when it is above that day's line + margin.
 *
 * This is deliberately a separate question from the ads' own verdicts: an adset can be made of ads
 * that each look acceptable and still cost more per purchase than any adset that worked before.
 *
 * Only days 1..incubationMaxDay have a line, and a CPP only exists once the adset has a purchase —
 * before that the first-purchase rules already cover it, so this one stands down rather than
 * guessing.
 *
 * @param {{daily: {date: string, spend: number, purchases: number}[]}[]} ads  every ad in the adset,
 *   paused ones included: their spend and purchases are part of the adset's history.
 * @param {object|null} benchmark  the product's entry from buildAdsetBenchmarks(...).products
 * @param {{through?: string}} [opts]  last date of the data window, so days without delivery at the
 *   end still count towards the adset's age.
 */
export function adsetCpp(ads, benchmark, cfg, opts = {}) {
  const result = {
    day: null, date: null, cumSpend: null, cumPurchases: null, cumCpp: null,
    ceiling: null, margin: cfg.cppMargin, upperBound: null, sampleSize: 0,
    verdict: null, reason: null,
  };

  const days = alignFromFirstSpend(sumByDate(ads), { through: opts.through });
  if (!days) return { ...result, reason: REASON.NO_BENCHMARK };
  // past its incubation days there is no per-day line to read, so this rule stops applying
  const d = days.length <= cfg.incubationMaxDay ? days[days.length - 1] : null;
  if (!d) return { ...result, reason: REASON.NO_BENCHMARK };

  const point = benchmark?.days?.[d.day - 1] ?? null;
  const base = {
    ...result,
    day: d.day,
    date: d.date,
    cumSpend: d.cumSpend,
    cumPurchases: d.cumPurchases,
    cumCpp: d.cumPurchases > 0 ? round2(d.cumSpend / d.cumPurchases) : null,
    ceiling: point?.ceiling ?? null,
    margin: point?.margin ?? cfg.cppMargin,
    upperBound: point?.upperBound ?? null,
    sampleSize: point?.sampleSize ?? 0,
  };
  // no purchase yet means no CPP to compare; the first-purchase rules own that case
  if (base.cumCpp === null || base.upperBound === null) return { ...base, reason: REASON.NO_BENCHMARK };

  const pause = above(base.cumCpp, base.upperBound);
  return {
    ...base,
    verdict: pause ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: pause ? REASON.ADSET_CPP_ABOVE_BENCHMARK : REASON.WITHIN_ADSET_CPP_BENCHMARK,
  };
}

/** Every ad's daily rows summed into one series for the adset, one entry per date. */
function sumByDate(ads) {
  const byDate = new Map();
  for (const ad of ads) {
    for (const d of ad.daily || []) {
      const t = byDate.get(d.date) || { date: d.date, spend: 0, purchases: 0 };
      t.spend = round2(t.spend + (Number(d.spend) || 0));
      t.purchases += Number(d.purchases) || 0;
      byDate.set(d.date, t);
    }
  }
  return [...byDate.values()];
}

/**
 * How many days the adset took to its first purchase, against the slowest successful ad of its
 * product (firstPurchaseDayLimit). Day 1 is the adset's first day with spend on any of its ads,
 * counted the same way as a successful ad's. Pause when it took longer: its first purchase came
 * after that day, or it has already gone past that day without one. Then the whole adset, and
 * every ad under it, is Pause.
 *
 * Only meaningful when the rows cover the adset's whole life; the caller decides that.
 *
 * @param {{daily: {date: string, spend: number, purchases: number}[]}[]} ads  every ad in the
 *   adset, paused ones included: their spend and purchases are part of the adset's history.
 * @param {object|null} benchmark  the product's entry from buildBenchmarks (for firstPurchaseDayLimit)
 * @param {{through?: string}} [opts]  last date of the data window, so days without delivery at the
 *   end still count towards how long the adset has gone without a purchase.
 * @returns {{
 *   verdict: "Keep"|"Pause"|null, reason: string|null,   // null when the adset never spent
 *   limit: number|null, sampleSize: number,
 *   firstSpendDate: string|null, ageDays: number,
 *   firstPurchaseDate: string|null, firstPurchaseDay: number|null
 * }}
 */
export function adsetFirstPurchase(ads, benchmark, opts = {}) {
  const limit = benchmark?.firstPurchaseDayLimit?.value ?? null;
  const result = {
    verdict: null,
    reason: null,
    limit,
    sampleSize: benchmark?.firstPurchaseDayLimit?.sampleSize ?? 0,
    firstSpendDate: null,
    ageDays: 0,
    firstPurchaseDate: null,
    firstPurchaseDay: null,
  };
  const days = alignFromFirstSpend(sumByDate(ads), { through: opts.through });
  if (!days) return result;

  const first = days.find((d) => d.cumPurchases > 0);
  result.firstSpendDate = days[0].date;
  result.ageDays = days.length;
  result.firstPurchaseDate = first ? first.date : null;
  result.firstPurchaseDay = first ? first.day : null;
  if (limit === null) return { ...result, verdict: VERDICT.KEEP, reason: REASON.NO_BENCHMARK };

  // with no purchase yet, it has taken at least as many days as it has run
  const took = first ? first.day : days.length;
  const slow = took > limit;
  return {
    ...result,
    verdict: slow ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: slow ? REASON.ADSET_FIRST_PURCHASE_TOO_SLOW : REASON.ADSET_FIRST_PURCHASE_IN_TIME,
  };
}

/** Statuses meaning the ad is already switched off in Meta. */
const OFF = /PAUSED|DELETED|ARCHIVED/i;

/** Is the ad still running in Meta? Unknown status counts as running. */
export function isRunning(status) {
  return !OFF.test(String(status ?? ""));
}

/**
 * The adset's Advise, from its ads' own verdicts: Pause if at least one running ad is Pause,
 * Keep if every running ad with a verdict is Keep, null when no running ad has a verdict.
 *
 * Ads already paused in Meta don't count — an ad you have already switched off shouldn't make
 * the whole adset read Pause.
 *
 * @param {{verdict: "Keep"|"Pause"|null, status?: string}[]} ads
 * @returns {{verdict: "Keep"|"Pause"|null, counted: number, pauseIndexes: number[], ignoredPaused: number}}
 */
export function rollUpAdset(ads) {
  let counted = 0;
  let ignoredPaused = 0;
  const pauseIndexes = [];
  ads.forEach((ad, i) => {
    if (!ad || !ad.verdict) return;
    if (!isRunning(ad.status)) {
      ignoredPaused++;
      return;
    }
    counted++;
    if (ad.verdict === VERDICT.PAUSE) pauseIndexes.push(i);
  });
  const verdict = counted === 0 ? null : pauseIndexes.length ? VERDICT.PAUSE : VERDICT.KEEP;
  return { verdict, counted, pauseIndexes, ignoredPaused };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
