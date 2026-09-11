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

function productBenchmark(product, candidates, cfg) {
  const maxCpp = cfg.maxCppByProduct?.[product] ?? null;
  const ads = candidates.filter((a) => meetsThreshold(a.days, maxCpp, cfg));
  const days = [];
  for (let day = 1; day <= cfg.incubationMaxDay; day++) {
    // CPP only exists once an ad has a purchase, so a day's sample is the ads that had one by then.
    const sample = ads
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

  const fpSample = ads.map((a) => spendBeforeFirstPurchase(a.days, cfg.incubationMaxDay)).filter((v) => v !== null);
  return {
    product,
    maxCpp,
    /** ads that ran 11+ days */
    candidates: candidates.length,
    /** of those, the ones within maxCpp at day successCppDay — the benchmark's actual sample */
    cohortSize: ads.length,
    days,
    firstPurchaseLimit: {
      value: fpSample.length ? round2(cfg.firstPurchaseStatistic.compute(fpSample)) : null,
      sampleSize: fpSample.length,
    },
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
