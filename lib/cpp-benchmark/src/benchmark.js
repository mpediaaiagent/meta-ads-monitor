import { SCHEMA_VERSION } from "./constants.js";
import { describeConfig, resolveConfig } from "./config.js";
import { alignFromFirstSpend, classifyProduct } from "./history.js";

/**
 * Builds each product's benchmarks from its successful ads.
 *
 * @param {{adId: string, campaignName: string, daily: {date: string, spend: number, purchases: number}[]}[]} successfulAds
 *   Ads that ran 11+ days (the monthly refresh stores only those, using isSuccessful). If
 *   options.maxCppByProduct has a threshold for the ad's product, the ad is used only when its
 *   cumulative CPP on day successCppDay (10) is at or under it — so the dashboard's editable
 *   threshold decides which long-running ads count, without re-fetching anything.
 * @param {object} [options] overrides for DEFAULT_CONFIG
 *
 * Products never mix: each product's numbers come only from its own ads, with no fallback to
 * another product's — educator program (much higher CPPs) can't distort the others or vice versa.
 * Nothing is cached, so calling it again with fresh data is all "refreshing" means.
 */
export function buildBenchmarks(successfulAds, options) {
  const cfg = resolveConfig(options);
  if (!Array.isArray(successfulAds)) throw new TypeError("successfulAds must be an array");

  const byProduct = new Map(cfg.products.map((p) => [p.product, []]));
  const unclassifiedAdIds = [];
  const neverSpentAdIds = [];
  for (const ad of successfulAds) {
    const product = classifyProduct(ad.campaignName, cfg);
    if (!product) {
      unclassifiedAdIds.push(String(ad.adId));
      continue;
    }
    const days = alignFromFirstSpend(ad.daily);
    if (!days) {
      neverSpentAdIds.push(String(ad.adId));
      continue;
    }
    byProduct.get(product).push({ adId: String(ad.adId), days });
  }

  const products = {};
  for (const [product, ads] of byProduct) products[product] = productBenchmark(product, ads, cfg);
  return { schemaVersion: SCHEMA_VERSION, config: describeConfig(cfg), products, unclassifiedAdIds, neverSpentAdIds };
}

// A CPP exactly on the threshold passes; this absorbs float noise at that boundary.
const EPSILON = 1e-9;

/** Cumulative CPP on `day`, or null when the ad had no purchase by then (or has no such day). */
export function cppOnDay(days, day) {
  const d = days[day - 1];
  return d && d.cumPurchases > 0 ? d.cumSpend / d.cumPurchases : null;
}

/** Does this ad pass its product's CPP threshold? No threshold means no filter. */
export function meetsThreshold(days, maxCpp, cfg) {
  if (maxCpp == null) return true;
  const cpp = cppOnDay(days, cfg.successCppDay);
  return cpp !== null && cpp <= maxCpp + EPSILON * Math.max(1, maxCpp);
}

/**
 * What a successful ad spent before its first purchase, looking only at the incubation window:
 * cumulative spend on the day of its first purchase, or on the window's last day if it had no
 * purchase by then. Counting past the window would let an ad that first bought on day 20 set the
 * limit for ads that are at most 9 days old.
 */
export function spendBeforeFirstPurchase(days, maxDay) {
  const window = days.slice(0, maxDay);
  if (window.length === 0) return null;
  const firstPurchase = window.find((d) => d.cumPurchases > 0);
  return (firstPurchase ?? window[window.length - 1]).cumSpend;
}

/** The day of an ad's first purchase (day 1 = its first day with spend) within days 1..maxDay, or null. */
export function firstPurchaseDay(days, maxDay) {
  const hit = days.slice(0, maxDay).find((d) => d.cumPurchases > 0);
  return hit ? hit.day : null;
}

/**
 * The day-by-day cumulative-CPP ceilings for a set of aligned histories. Shared by the ad-level
 * and adset-level benchmarks so both are drawn the same way — same statistic, same margin, same
 * "a day's sample is whoever had a purchase by then" rule.
 *
 * @param {{days: {cumSpend: number, cumPurchases: number}[]}[]} cohort  already filtered to the
 *   histories that count (see meetsThreshold)
 */
export function dayCeilings(cohort, cfg) {
  const days = [];
  for (let day = 1; day <= cfg.incubationMaxDay; day++) {
    // CPP only exists once there is a purchase, so a day's sample is whoever had one by then.
    const sample = cohort
      .map((a) => a.days[day - 1])
      .filter((d) => d && d.cumPurchases > 0)
      .map((d) => d.cumSpend / d.cumPurchases);
    const ceiling = sample.length ? round2(cfg.ceilingStatistic.compute(sample)) : null;
    days.push({
      day,
      sampleSize: sample.length,
      ceiling,
      margin: cfg.cppMargin,
      upperBound: ceiling === null ? null : round2(ceiling * (1 + cfg.cppMargin)),
    });
  }
  return days;
}

/**
 * Each product's adset-level benchmark: what a whole adset's cumulative CPP looked like day by day,
 * across the past adsets that were acceptable at day successCppDay. A live adset above its day's
 * line is Pause even when its individual ads each pass — that is the point of the rule.
 *
 * @param {{adsetKey: string, campaignName: string, daily: {date: string, spend: number, purchases: number}[]}[]} adsets
 *   one entry per past adset, its ads already summed together by date (see the note in
 *   lib/dashboard/advise.js about which ads that covers).
 * @param {object} [options] overrides for DEFAULT_CONFIG
 */
export function buildAdsetBenchmarks(adsets, options) {
  const cfg = resolveConfig(options);
  if (!Array.isArray(adsets)) throw new TypeError("adsets must be an array");

  const byProduct = new Map(cfg.products.map((p) => [p.product, []]));
  const unclassifiedAdsetKeys = [];
  const neverSpentAdsetKeys = [];
  for (const a of adsets) {
    const product = classifyProduct(a.campaignName, cfg);
    if (!product) {
      unclassifiedAdsetKeys.push(String(a.adsetKey));
      continue;
    }
    const days = alignFromFirstSpend(a.daily);
    if (!days) {
      neverSpentAdsetKeys.push(String(a.adsetKey));
      continue;
    }
    byProduct.get(product).push({ adsetKey: String(a.adsetKey), days });
  }

  const products = {};
  for (const [product, candidates] of byProduct) {
    const maxCpp = cfg.maxCppByProduct?.[product] ?? null;
    // the same threshold that picks the ad cohort picks the adset cohort, so an adset that was
    // already too expensive at day 10 can't raise the line for everyone else
    const cohort = candidates.filter((a) => meetsThreshold(a.days, maxCpp, cfg));
    // What a past adset of this product spent before it first converted. Unlike the ad-level
    // firstPurchaseLimit this one carries cppMargin: an adset pools several ads, so its
    // pre-purchase spend is lumpier than any single ad's and the headroom stops that noise from
    // pausing adsets that are merely a bit unlucky.
    const fpSample = cohort.map((a) => spendBeforeFirstPurchase(a.days, cfg.incubationMaxDay)).filter((v) => v !== null);
    const fpCeiling = fpSample.length ? round2(cfg.firstPurchaseStatistic.compute(fpSample)) : null;
    products[product] = {
      product,
      maxCpp,
      candidates: candidates.length,
      cohortSize: cohort.length,
      days: dayCeilings(cohort, cfg),
      firstPurchaseSpendLimit: {
        /** the line an adset with no purchase yet is judged against: ceiling + margin */
        value: fpCeiling === null ? null : round2(fpCeiling * (1 + cfg.cppMargin)),
        /** the most any past adset of this product spent before its first purchase */
        ceiling: fpCeiling,
        margin: cfg.cppMargin,
        sampleSize: fpSample.length,
      },
    };
  }
  return { schemaVersion: SCHEMA_VERSION, config: describeConfig(cfg), products, unclassifiedAdsetKeys, neverSpentAdsetKeys };
}

function productBenchmark(product, candidates, cfg) {
  const maxCpp = cfg.maxCppByProduct?.[product] ?? null;
  const ads = candidates.filter((a) => meetsThreshold(a.days, maxCpp, cfg));
  const days = dayCeilings(ads, cfg);

  const fpSample = ads.map((a) => spendBeforeFirstPurchase(a.days, cfg.incubationMaxDay)).filter((v) => v !== null);
  // The dashboard's spend-with-no-purchase threshold, when set, replaces the derived limit. The
  // derived value is kept alongside it so the UI can still show what the successful ads did.
  const derivedFirstPurchase = fpSample.length ? round2(cfg.firstPurchaseStatistic.compute(fpSample)) : null;
  const fpOverride = cfg.maxSpendNoPurchaseByProduct?.[product] ?? null;
  // How long the slowest successful ad took to its first purchase. Looked for up to successCppDay,
  // the last day the threshold check reads, so a thresholded cohort always has one per ad. An ad
  // without one (possible only with no threshold) took longer than the data shows, so the worst
  // case is unknown: the limit is left out rather than understated.
  const fpDays = ads.map((a) => firstPurchaseDay(a.days, cfg.successCppDay));
  const fpDaysKnown = fpDays.length > 0 && fpDays.every((v) => v !== null);
  return {
    product,
    maxCpp,
    /** the edited spend-with-no-purchase threshold for this product, or null when none is set */
    maxSpendNoPurchase: fpOverride,
    /** ads that ran 11+ days */
    candidates: candidates.length,
    /** of those, the ones within maxCpp at day successCppDay — the benchmark's actual sample */
    cohortSize: ads.length,
    days,
    firstPurchaseLimit: {
      value: fpOverride ?? derivedFirstPurchase,
      sampleSize: fpSample.length,
      /** "threshold" when the edited number decided it, "benchmark" when the successful ads did */
      source: fpOverride != null ? "threshold" : "benchmark",
      /** what the successful ads alone would have set, whether or not the threshold overrode it */
      derived: derivedFirstPurchase,
    },
    /** the day the slowest successful ad made its first purchase; an adset slower than this is Pause */
    firstPurchaseDayLimit: {
      value: fpDaysKnown ? round2(cfg.firstPurchaseDayStatistic.compute(fpDays)) : null,
      sampleSize: fpDays.length,
    },
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
