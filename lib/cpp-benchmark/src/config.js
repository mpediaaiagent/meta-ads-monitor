import { STATISTICS, isStatistic } from "./statistics.js";
import { TRAJECTORY } from "./constants.js";

// Every tunable number in the calculation lives in this file. The logic modules read them from the
// resolved config and never embed a literal, so retuning means passing overrides, not editing code:
//
//   runBenchmark(rows, { margin: { earlyStart: 0.25 }, ceilingStatistic: STATISTICS.percentile(80) })
//
// Rates are fractions throughout: 0.10 means 10%.

/**
 * Day-10 goal per product. An ad joins its product's successful cohort when, at day 10, its
 * cumulative CPP is <= maxCpp AND its cumulative purchases are >= minPurchases.
 *
 * These equal the 10-day columns of D1's `ad_closing_threshold` as of 2026-09-11. That table is
 * editable from the dashboard, so whoever wires this module up should pass the live values in as
 * `goals` rather than rely on these. Keys are normalised product names (see normalizeProduct).
 */
export const DEFAULT_PRODUCT_GOALS = Object.freeze({
  "adi anku": Object.freeze({ maxCpp: 280, minPurchases: 17 }),
  "educator program": Object.freeze({ maxCpp: 700, minPurchases: 1 }),
  gulu: Object.freeze({ maxCpp: 280, minPurchases: 17 }),
  mpedia: Object.freeze({ maxCpp: 280, minPurchases: 17 }),
  trubuddy: Object.freeze({ maxCpp: 280, minPurchases: 17 }),
});

export const DEFAULT_CONFIG = Object.freeze({
  /** The curve covers days 1..horizonDays, and runway counts down to it. */
  horizonDays: 10,

  goals: DEFAULT_PRODUCT_GOALS,

  /** How a day's ceiling is drawn from the cohort's CPPs. Swap for STATISTICS.percentile(75 or 80) if max proves too outlier-sensitive. */
  ceilingStatistic: STATISTICS.max,

  /** A product/day with fewer successful-cohort ads than this gets no ceiling and is flagged low confidence. */
  minCohortSize: 3,

  margin: Object.freeze({
    /** Headroom above the ceiling once the early taper is over. */
    standard: 0.1,
    /** PLACEHOLDER: day-1 headroom. Set it from the cohort's real day-1 spread once that history exists. */
    earlyStart: 0.3,
    /**
     * PLACEHOLDER, as above. The margin tapers linearly from earlyStart on day 1 down to standard
     * on day taperDays + 1, so with 5, days 1–5 are wider and day 6 onward is standard.
     */
    taperDays: 5,
    /** Optional explicit margins for days 1..steps.length, e.g. [0.3, 0.25, 0.2, 0.15, 0.12]. Overrides the linear taper when set. */
    steps: null,
  }),

  floor: Object.freeze({
    /** An ad is evaluated once it has spent at least this much (₹)... */
    minCumSpend: 150,
    /** ...or has at least this many purchases, whichever comes first. */
    minCumPurchases: 1,
  }),

  trajectory: Object.freeze({
    /** Compare today's cumulative CPP with the one this many days earlier (2 = a 3-day span). */
    lookbackDays: 2,
    /** A relative change within ± this is "flat". */
    flatTolerance: 0.025,
    /** How the remark step reads "unknown" (no earlier post-floor day to compare with). Flat is the cautious choice: it never earns scale_candidate or hold. */
    treatUnknownAs: TRAJECTORY.FLAT,
  }),

  runway: Object.freeze({
    /** Runway (days left until the horizon) at or below this is "low": outside becomes pause_candidate instead of wait_one_more_day. */
    lowMaxDays: 3,
    /** reduce_spend urgency: high at or below highMaxDays of runway, medium at or below mediumMaxDays, low above that. */
    reduceSpendUrgency: Object.freeze({ highMaxDays: 2, mediumMaxDays: 5 }),
  }),
});

const RESOLVED = Symbol("cpp-benchmark.resolvedConfig");
const SECTIONS = ["margin", "floor", "trajectory", "runway"];

/** Lower-case, trimmed, single-spaced — so "Adi Anku" and "adi  anku" are the same product. */
export function normalizeProduct(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Merges overrides onto DEFAULT_CONFIG, validates the result and freezes it. Sections merge
 * key-by-key (overriding margin.earlyStart keeps the other margin values); `goals` is replaced
 * wholesale, so a caller passing the live thresholds gets exactly those products and no stale
 * defaults. Unknown keys throw, so a typo like `margins` can't be silently ignored.
 * Passing an already-resolved config returns it unchanged.
 */
export function resolveConfig(overrides = {}) {
  if (overrides?.[RESOLVED]) return overrides;
  assertKnownKeys(overrides, DEFAULT_CONFIG, "config");
  for (const section of SECTIONS) {
    if (overrides[section] !== undefined) {
      assertKnownKeys(overrides[section], DEFAULT_CONFIG[section], section);
    }
  }
  if (overrides.runway?.reduceSpendUrgency !== undefined) {
    assertKnownKeys(overrides.runway.reduceSpendUrgency, DEFAULT_CONFIG.runway.reduceSpendUrgency, "runway.reduceSpendUrgency");
  }

  const D = DEFAULT_CONFIG;
  const margin = { ...D.margin, ...overrides.margin };
  if (Array.isArray(margin.steps)) margin.steps = [...margin.steps];
  const cfg = {
    horizonDays: overrides.horizonDays ?? D.horizonDays,
    goals: normalizeGoals(overrides.goals ?? D.goals),
    ceilingStatistic: overrides.ceilingStatistic ?? D.ceilingStatistic,
    minCohortSize: overrides.minCohortSize ?? D.minCohortSize,
    margin,
    floor: { ...D.floor, ...overrides.floor },
    trajectory: { ...D.trajectory, ...overrides.trajectory },
    runway: {
      ...D.runway,
      ...overrides.runway,
      reduceSpendUrgency: { ...D.runway.reduceSpendUrgency, ...overrides.runway?.reduceSpendUrgency },
    },
  };

  validate(cfg);
  Object.defineProperty(cfg, RESOLVED, { value: true });
  return deepFreeze(cfg);
}

/** A JSON-safe snapshot of the settings a result was computed with, for the output envelope. */
export function describeConfig(cfg) {
  return {
    horizonDays: cfg.horizonDays,
    goals: structuredClone(cfg.goals),
    ceilingStatistic: cfg.ceilingStatistic.name,
    minCohortSize: cfg.minCohortSize,
    margin: { ...cfg.margin, steps: cfg.margin.steps ? [...cfg.margin.steps] : null },
    floor: { ...cfg.floor },
    trajectory: { ...cfg.trajectory },
    runway: { ...cfg.runway, reduceSpendUrgency: { ...cfg.runway.reduceSpendUrgency } },
  };
}

function normalizeGoals(goals) {
  if (goals === null || typeof goals !== "object" || Array.isArray(goals)) {
    throw new TypeError("goals must be an object keyed by product name");
  }
  const out = {};
  for (const [name, goal] of Object.entries(goals)) {
    const key = normalizeProduct(name);
    if (Object.hasOwn(out, key)) throw new RangeError(`goals lists product "${key}" twice`);
    out[key] = { maxCpp: goal?.maxCpp, minPurchases: goal?.minPurchases };
  }
  return out;
}

function validate(cfg) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(message);
  const isInt = (v, min) => Number.isInteger(v) && v >= min;
  const isRate = (v) => Number.isFinite(v) && v >= 0;

  need(isInt(cfg.horizonDays, 1), `horizonDays must be an integer >= 1, got ${cfg.horizonDays}`);
  need(Object.keys(cfg.goals).length > 0, "goals must list at least one product");
  for (const [product, g] of Object.entries(cfg.goals)) {
    need(product !== "", "goals has an empty product name");
    need(Number.isFinite(g.maxCpp) && g.maxCpp > 0, `goals["${product}"].maxCpp must be a number > 0, got ${g.maxCpp}`);
    need(isInt(g.minPurchases, 1), `goals["${product}"].minPurchases must be an integer >= 1, got ${g.minPurchases}`);
  }
  need(isStatistic(cfg.ceilingStatistic), "ceilingStatistic must be { name, compute(values) } (see STATISTICS)");
  need(isInt(cfg.minCohortSize, 1), `minCohortSize must be an integer >= 1, got ${cfg.minCohortSize}`);

  const m = cfg.margin;
  need(isRate(m.standard), `margin.standard must be a rate >= 0, got ${m.standard}`);
  need(isRate(m.earlyStart) && m.earlyStart >= m.standard, `margin.earlyStart must be a rate >= margin.standard, got ${m.earlyStart}`);
  need(isInt(m.taperDays, 0), `margin.taperDays must be an integer >= 0, got ${m.taperDays}`);
  need(
    m.steps === null || (Array.isArray(m.steps) && m.steps.length <= cfg.horizonDays && m.steps.every(isRate)),
    "margin.steps must be null or an array of rates >= 0, no longer than horizonDays"
  );

  need(Number.isFinite(cfg.floor.minCumSpend) && cfg.floor.minCumSpend >= 0, `floor.minCumSpend must be a number >= 0, got ${cfg.floor.minCumSpend}`);
  need(isInt(cfg.floor.minCumPurchases, 1), `floor.minCumPurchases must be an integer >= 1, got ${cfg.floor.minCumPurchases}`);

  const t = cfg.trajectory;
  need(isInt(t.lookbackDays, 1), `trajectory.lookbackDays must be an integer >= 1, got ${t.lookbackDays}`);
  need(isRate(t.flatTolerance), `trajectory.flatTolerance must be a rate >= 0, got ${t.flatTolerance}`);
  need(
    [TRAJECTORY.IMPROVING, TRAJECTORY.FLAT, TRAJECTORY.WORSENING].includes(t.treatUnknownAs),
    `trajectory.treatUnknownAs must be improving, flat or worsening, got ${t.treatUnknownAs}`
  );

  const r = cfg.runway;
  need(isInt(r.lowMaxDays, 0), `runway.lowMaxDays must be an integer >= 0, got ${r.lowMaxDays}`);
  const u = r.reduceSpendUrgency;
  need(
    isInt(u.highMaxDays, 0) && isInt(u.mediumMaxDays, 0) && u.highMaxDays <= u.mediumMaxDays,
    `runway.reduceSpendUrgency needs integers with highMaxDays <= mediumMaxDays, got ${u.highMaxDays}/${u.mediumMaxDays}`
  );

  if (problems.length) throw new RangeError(`Invalid cpp-benchmark config:\n  - ${problems.join("\n  - ")}`);
}

function assertKnownKeys(obj, allowed, label) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError(`${label} must be an object`);
  }
  const unknown = Object.keys(obj).filter((k) => !Object.hasOwn(allowed, k));
  if (unknown.length) {
    throw new RangeError(`Unknown ${label} key(s): ${unknown.join(", ")} (allowed: ${Object.keys(allowed).join(", ")})`);
  }
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}
