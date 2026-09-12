import { STATISTICS, isStatistic } from "./statistics.js";

// Every tunable number in the calculation lives in this file. The logic modules read them from the
// resolved config and never embed a literal, so retuning means passing overrides, not editing code:
//
//   buildBenchmarks(ads, { cppMargin: 0.15, ceilingStatistic: STATISTICS.percentile(80) })
//
// Rates are fractions throughout: 0.10 means 10%.

/**
 * Product is read from the CAMPAIGN name — the same convention the daily adset task uses. A
 * campaign that matches none of these, or more than one, is unclassified and never judged.
 */
export const DEFAULT_PRODUCTS = Object.freeze([
  Object.freeze({ product: "trubuddy", pattern: /trubuddy/i }),
  Object.freeze({ product: "mpedia", pattern: /mpedia/i }),
  Object.freeze({ product: "gulu", pattern: /gulu/i }),
  Object.freeze({ product: "educator program", pattern: /educator/i }),
  Object.freeze({ product: "adi anku", pattern: /adi[\s_-]*anku/i }),
]);

export const DEFAULT_CONFIG = Object.freeze({
  /** A benchmark ("successful") ad spent on its day 11 or later, counting day 1 as its first day with spend. */
  successMinDays: 11,

  /**
   * Per-product CPP ceiling for a successful ad, e.g. { trubuddy: 280, "educator program": 700 }.
   * An ad joins its product's benchmark only if its cumulative CPP on day successCppDay is at or
   * under this (so it needs at least one purchase by then). The same number judges ads past
   * incubation on their 10-day window. Edited from the dashboard (D1 table benchmark_thresholds);
   * null, or a product missing from it, means no CPP filter for that product.
   */
  maxCppByProduct: null,

  /**
   * Per-product ceiling on spend before the first purchase, e.g. { trubuddy: 900 }. Set from the
   * dashboard (D1 table benchmark_thresholds), it REPLACES the limit that would otherwise be drawn
   * from the successful ads' own spend-before-first-purchase. A product missing from it, or set to
   * null, keeps the derived limit — so leaving the field blank is the old behaviour exactly.
   * Applies wherever an ad has no purchase yet: its incubation days and its 10-day window.
   */
  maxSpendNoPurchaseByProduct: null,

  /** Which day's cumulative CPP is checked against maxCppByProduct. */
  successCppDay: 10,

  /** Ads are judged on days 1..incubationMaxDay. From the day after, the adset-level rule takes over. */
  incubationMaxDay: 9,

  /** Headroom on top of each day's cumulative-CPP benchmark. Flat for every day. Not applied to the first-purchase limit. */
  cppMargin: 0.1,

  /** How a day's CPP benchmark is drawn from the successful ads' cumulative CPPs. */
  ceilingStatistic: STATISTICS.max,

  /** How the first-purchase limit is drawn from the successful ads' spend-before-first-purchase. */
  firstPurchaseStatistic: STATISTICS.max,

  /**
   * How the adset first-purchase day limit is drawn from the day each successful ad made its first
   * purchase. An adset whose first purchase takes longer than this is Pause, with every ad in it.
   */
  firstPurchaseDayStatistic: STATISTICS.max,

  products: DEFAULT_PRODUCTS,
});

const RESOLVED = Symbol("cpp-benchmark.resolvedConfig");

/**
 * Merges overrides onto DEFAULT_CONFIG, validates and freezes the result. Unknown keys throw, so
 * a typo can't be silently ignored. Passing an already-resolved config returns it unchanged.
 */
export function resolveConfig(overrides = {}) {
  if (overrides?.[RESOLVED]) return overrides;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("options must be an object");
  }
  const unknown = Object.keys(overrides).filter((k) => !Object.hasOwn(DEFAULT_CONFIG, k));
  if (unknown.length) {
    throw new RangeError(`Unknown config key(s): ${unknown.join(", ")} (allowed: ${Object.keys(DEFAULT_CONFIG).join(", ")})`);
  }

  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  cfg.products = (overrides.products ?? DEFAULT_PRODUCTS).map((p) => Object.freeze({ product: p?.product, pattern: p?.pattern }));
  if (cfg.maxCppByProduct != null) cfg.maxCppByProduct = Object.freeze({ ...cfg.maxCppByProduct });
  if (cfg.maxSpendNoPurchaseByProduct != null) cfg.maxSpendNoPurchaseByProduct = Object.freeze({ ...cfg.maxSpendNoPurchaseByProduct });
  validate(cfg);
  Object.defineProperty(cfg, RESOLVED, { value: true });
  Object.freeze(cfg.products);
  return Object.freeze(cfg);
}

/** A JSON-safe snapshot of the settings a result was computed with. */
export function describeConfig(cfg) {
  return {
    successMinDays: cfg.successMinDays,
    maxCppByProduct: cfg.maxCppByProduct ? { ...cfg.maxCppByProduct } : null,
    maxSpendNoPurchaseByProduct: cfg.maxSpendNoPurchaseByProduct ? { ...cfg.maxSpendNoPurchaseByProduct } : null,
    successCppDay: cfg.successCppDay,
    incubationMaxDay: cfg.incubationMaxDay,
    cppMargin: cfg.cppMargin,
    ceilingStatistic: cfg.ceilingStatistic.name,
    firstPurchaseStatistic: cfg.firstPurchaseStatistic.name,
    firstPurchaseDayStatistic: cfg.firstPurchaseDayStatistic.name,
    products: cfg.products.map((p) => ({ product: p.product, pattern: p.pattern.source })),
  };
}

function validate(cfg) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(message);
  const isInt = (v, min) => Number.isInteger(v) && v >= min;

  need(isInt(cfg.incubationMaxDay, 1), `incubationMaxDay must be an integer >= 1, got ${cfg.incubationMaxDay}`);
  need(
    isInt(cfg.successMinDays, 1) && cfg.successMinDays > cfg.incubationMaxDay,
    `successMinDays must be an integer greater than incubationMaxDay, got ${cfg.successMinDays}`
  );
  need(
    isInt(cfg.successCppDay, 1) && cfg.successCppDay < cfg.successMinDays,
    `successCppDay must be an integer from 1 to successMinDays - 1, got ${cfg.successCppDay}`
  );
  if (cfg.maxCppByProduct != null) {
    need(typeof cfg.maxCppByProduct === "object" && !Array.isArray(cfg.maxCppByProduct), "maxCppByProduct must be an object keyed by product");
    for (const [product, v] of Object.entries(cfg.maxCppByProduct || {})) {
      need(v === null || (Number.isFinite(v) && v > 0), `maxCppByProduct["${product}"] must be a number > 0 or null, got ${v}`);
    }
  }
  if (cfg.maxSpendNoPurchaseByProduct != null) {
    need(
      typeof cfg.maxSpendNoPurchaseByProduct === "object" && !Array.isArray(cfg.maxSpendNoPurchaseByProduct),
      "maxSpendNoPurchaseByProduct must be an object keyed by product"
    );
    for (const [product, v] of Object.entries(cfg.maxSpendNoPurchaseByProduct || {})) {
      need(v === null || (Number.isFinite(v) && v > 0), `maxSpendNoPurchaseByProduct["${product}"] must be a number > 0 or null, got ${v}`);
    }
  }
  need(Number.isFinite(cfg.cppMargin) && cfg.cppMargin >= 0, `cppMargin must be a rate >= 0, got ${cfg.cppMargin}`);
  need(isStatistic(cfg.ceilingStatistic), "ceilingStatistic must be { name, compute(values) } (see STATISTICS)");
  need(isStatistic(cfg.firstPurchaseStatistic), "firstPurchaseStatistic must be { name, compute(values) } (see STATISTICS)");
  need(isStatistic(cfg.firstPurchaseDayStatistic), "firstPurchaseDayStatistic must be { name, compute(values) } (see STATISTICS)");
  need(cfg.products.length > 0, "products must list at least one product");
  const seen = new Set();
  for (const p of cfg.products) {
    need(typeof p.product === "string" && p.product.trim() !== "", "every product needs a name");
    need(p.pattern instanceof RegExp, `product "${p.product}" needs a RegExp pattern`);
    need(!seen.has(p.product), `product "${p.product}" is listed twice`);
    seen.add(p.product);
  }
  if (problems.length) throw new RangeError(`Invalid cpp-benchmark config:\n  - ${problems.join("\n  - ")}`);
}
