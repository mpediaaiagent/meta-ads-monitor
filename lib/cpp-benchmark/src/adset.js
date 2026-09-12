import { REASON, VERDICT } from "./constants.js";
import { alignFromFirstSpend } from "./history.js";
import { effectiveCpp, judgeProductThreshold } from "./thresholds.js";

/**
 * The adset's latest day, and whether an adset-level rule is allowed to look at it at all. Days
 * 1..adsetImmuneDays are immune: too early to read anything into, and an adset paused on day 1 is
 * never given a chance. Its ads are still judged on their own rules.
 *
 * @returns {{days: object[]|null, latest: object|null, immune: boolean}}
 */
export function adsetDays(ads, cfg, opts = {}) {
  const days = alignFromFirstSpend(sumByDate(ads), { through: opts.through });
  if (!days) return { days: null, latest: null, immune: false };
  const latest = days[days.length - 1];
  return { days, latest, immune: latest.day <= cfg.adsetImmuneDays };
}

/**
 * The adset's latest day against its product's own day-wise threshold (productDayThresholds).
 * This is what can overrule a 3-month benchmark flag: inside the product's threshold is Keep,
 * whatever the benchmark said. With no purchase yet the spend itself counts as the CPP.
 *
 * @param {{daily: {date: string, spend: number, purchases: number}[]}[]} ads every ad in the adset
 * @param {object[]|null} schedule the product's entry from cfg.productDayThresholds
 */
export function adsetProductThreshold(ads, schedule, cfg, opts = {}) {
  const { latest, immune } = adsetDays(ads, cfg, opts);
  if (!latest) return { checked: false, notChecked: "no_spend", day: null, verdict: null, reason: null };
  if (immune) {
    return { checked: false, notChecked: REASON.IMMUNE_EARLY_DAYS, day: latest.day, verdict: null, reason: REASON.IMMUNE_EARLY_DAYS };
  }
  return judgeProductThreshold(latest, schedule);
}

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
  if (d.day <= cfg.adsetImmuneDays) return { ...result, day: d.day, date: d.date, reason: REASON.IMMUNE_EARLY_DAYS };

  const point = benchmark?.days?.[d.day - 1] ?? null;
  const base = {
    ...result,
    day: d.day,
    date: d.date,
    cumSpend: d.cumSpend,
    cumPurchases: d.cumPurchases,
    // with no purchase, the adset's spend is its CPP — so this rule applies to an unconverted
    // adset too, alongside adsetSpendBeforeFirstPurchase rather than instead of it
    cumCpp: effectiveCpp(d.cumSpend, d.cumPurchases),
    ceiling: point?.ceiling ?? null,
    margin: point?.margin ?? cfg.cppMargin,
    upperBound: point?.upperBound ?? null,
    sampleSize: point?.sampleSize ?? 0,
  };
  if (base.cumCpp === null || base.upperBound === null) return { ...base, reason: REASON.NO_BENCHMARK };

  const pause = above(base.cumCpp, base.upperBound);
  return {
    ...base,
    verdict: pause ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: pause ? REASON.ADSET_CPP_ABOVE_BENCHMARK : REASON.WITHIN_ADSET_CPP_BENCHMARK,
  };
}

/**
 * What the adset has spent so far without a single purchase, against what past adsets of the same
 * product spent before theirs (firstPurchaseSpendLimit, which already carries the margin). Pause
 * once it has spent more.
 *
 * Only applies while the adset has **no purchase at all**. Once it has converted, its CPP is the
 * fair question and adsetCpp asks it — judging a converted adset on its pre-purchase spend would
 * leave it on Pause forever however good its CPP became, which is the same reason the ad-level
 * rule stands down after the first purchase.
 *
 * Also only days 1..incubationMaxDay: an adset that is older than that and still hasn't converted
 * is already caught by the first-purchase *day* limit (adsetFirstPurchase).
 *
 * @param {{daily: {date: string, spend: number, purchases: number}[]}[]} ads  every ad in the adset
 * @param {object|null} benchmark  the product's entry from buildAdsetBenchmarks(...).products
 * @param {{through?: string}} [opts]  last date of the data window
 */
export function adsetSpendBeforeFirstPurchase(ads, benchmark, cfg, opts = {}) {
  const limit = benchmark?.firstPurchaseSpendLimit ?? null;
  const result = {
    day: null, date: null, cumSpend: null, cumPurchases: null,
    limit: limit?.value ?? null, ceiling: limit?.ceiling ?? null,
    margin: limit?.margin ?? cfg.cppMargin, sampleSize: limit?.sampleSize ?? 0,
    verdict: null, reason: null,
  };

  const days = alignFromFirstSpend(sumByDate(ads), { through: opts.through });
  if (!days) return { ...result, reason: REASON.NO_BENCHMARK };
  if (days.length > cfg.incubationMaxDay) return { ...result, reason: REASON.NO_BENCHMARK };

  const d = days[days.length - 1];
  const base = { ...result, day: d.day, date: d.date, cumSpend: d.cumSpend, cumPurchases: d.cumPurchases };
  if (d.day <= cfg.adsetImmuneDays) return { ...base, reason: REASON.IMMUNE_EARLY_DAYS };
  // it has converted, so this rule is done with it
  if (d.cumPurchases > 0) return { ...base, reason: REASON.ADSET_FIRST_PURCHASE_IN_TIME };
  if (result.limit === null) return { ...base, reason: REASON.NO_BENCHMARK };

  const pause = above(d.cumSpend, result.limit);
  return {
    ...base,
    verdict: pause ? VERDICT.PAUSE : VERDICT.KEEP,
    reason: pause ? REASON.ADSET_SPEND_WITHOUT_PURCHASE : REASON.WITHIN_ADSET_FIRST_PURCHASE_LIMIT,
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
export function adsetFirstPurchase(ads, benchmark, cfg, opts = {}) {
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
  // too young for any adset-level rule to read anything into
  if (days.length <= cfg.adsetImmuneDays) return { ...result, reason: REASON.IMMUNE_EARLY_DAYS };
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
