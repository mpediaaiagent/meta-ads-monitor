import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarkCurves, marginForDay, resolveConfig, STATISTICS, CONFIDENCE } from "../src/index.js";
import { adRows, adWithCpp, MPEDIA_COHORT, MPEDIA_CEILINGS } from "./fixtures.js";

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ${expected}, got ${actual}`);

// Ads that must NOT join the mpedia cohort, each with a day-1 CPP far above the real ceiling so
// that letting any of them in would visibly move it.
const NON_COHORT = [
  // finishes at 320 > 280
  ...adWithCpp("D-too-expensive", "mpedia", [900, 800, 700, 600, 500, 450, 400, 350, 330, 320]),
  // 200 CPP, but only 15 purchases < 17
  ...adRows("E-too-few", "mpedia", [[1000, 1], [1200, 3], [1250, 5], [1400, 7], [1800, 9], [2000, 10], [2200, 11], [2400, 12], [2800, 14], [3000, 15]]),
  // great numbers, but only ran 9 days
  ...adWithCpp("F-too-short", "mpedia", [1500, 800, 550, 420, 340, 290, 250, 220, 200]),
];

test("cohort is only the ads that ran >= 10 days and met both halves of the goal", () => {
  const { products } = buildBenchmarkCurves([...MPEDIA_COHORT, ...NON_COHORT]);
  assert.deepEqual(products.mpedia.cohortAdIds, ["A", "B", "C"]);
  assert.equal(products.mpedia.cohortSize, 3);
  assert.deepEqual(products.mpedia.goal, { maxCpp: 280, minPurchases: 17 });
});

test("ceiling is the max cohort CPP per day, with the margin and upper bound on top", () => {
  const { products, ceilingStatistic } = buildBenchmarkCurves([...MPEDIA_COHORT, ...NON_COHORT]);
  assert.equal(ceilingStatistic, "max");
  const days = products.mpedia.days;
  assert.equal(days.length, 10);
  assert.deepEqual(days.map((d) => d.ceiling), MPEDIA_CEILINGS);
  assert.ok(days.every((d) => d.confidence === CONFIDENCE.OK && d.sampleSize === 3));
  close(days[0].margin, 0.3);
  close(days[0].upperBound, 455, "day 1 upper bound");
  close(days[9].margin, 0.1);
  close(days[9].upperBound, 302.5, "day 10 upper bound");
});

test("ceiling statistic is swappable without touching the logic", () => {
  const p50 = buildBenchmarkCurves(MPEDIA_COHORT, { ceilingStatistic: STATISTICS.percentile(50) });
  const p75 = buildBenchmarkCurves(MPEDIA_COHORT, { ceilingStatistic: STATISTICS.percentile(75) });
  assert.equal(p75.ceilingStatistic, "p75");
  // day 1 sample is [250, 300, 350]
  assert.equal(p50.products.mpedia.days[0].ceiling, 300);
  assert.equal(p75.products.mpedia.days[0].ceiling, 325);
  // a custom statistic only has to be { name, compute }
  const min = { name: "min", compute: (v) => Math.min(...v) };
  assert.equal(buildBenchmarkCurves(MPEDIA_COHORT, { ceilingStatistic: min }).products.mpedia.days[0].ceiling, 250);
});

test("percentile interpolates like PERCENTILE.INC and rejects bad input", () => {
  assert.equal(STATISTICS.percentile(50).compute([4, 1, 3, 2]), 2.5);
  assert.equal(STATISTICS.percentile(80).compute([10, 20, 30, 40, 50]), 42);
  assert.equal(STATISTICS.percentile(100).compute([7, 9, 8]), 9);
  assert.equal(STATISTICS.percentile(0).compute([7, 9, 8]), 7);
  assert.throws(() => STATISTICS.percentile(101), RangeError);
  assert.throws(() => STATISTICS.max.compute([]), RangeError);
});

test("fewer cohort ads than minCohortSize gives low confidence and no ceiling", () => {
  const twoAds = MPEDIA_COHORT.filter((r) => r.adId !== "C");
  const low = buildBenchmarkCurves(twoAds).products.mpedia;
  assert.equal(low.cohortSize, 2);
  for (const d of low.days) {
    assert.equal(d.confidence, CONFIDENCE.LOW);
    assert.equal(d.ceiling, null);
    assert.equal(d.upperBound, null);
    assert.equal(d.sampleSize, 2);
  }
  const ok = buildBenchmarkCurves(twoAds, { minCohortSize: 2 }).products.mpedia;
  assert.ok(ok.days.every((d) => d.confidence === CONFIDENCE.OK));
  assert.equal(ok.days[0].ceiling, 350);
});

test("every configured product gets a curve, even with no ads at all", () => {
  const { products } = buildBenchmarkCurves(MPEDIA_COHORT);
  assert.deepEqual(Object.keys(products).sort(), ["adi anku", "educator program", "gulu", "mpedia", "trubuddy"]);
  for (const name of ["adi anku", "gulu", "trubuddy", "educator program"]) {
    assert.equal(products[name].cohortSize, 0);
    assert.ok(products[name].days.every((d) => d.confidence === CONFIDENCE.LOW && d.ceiling === null));
  }
});

// Educator program: 700 / 1. EA has no purchase on day 1, so its day-1 point is its spend (600).
const EDUCATOR_COHORT = [
  ...adRows("EA", "educator program", [[600, 0], [700, 1], [900, 1], [1000, 2], [1100, 2], [1200, 2], [1300, 2], [1300, 2], [1350, 2], [1400, 2]]),
  ...adRows("EB", "educator program", [[300, 1], [600, 1], [800, 2], [900, 2], [1000, 2], [1100, 2], [1100, 2], [1200, 2], [1250, 2], [1300, 2]]),
  ...adRows("EC", "educator program", [[500, 1], [500, 1], [600, 1], [650, 1], [700, 1], [700, 1], [700, 1], [700, 1], [700, 1], [700, 1]]),
];

test("educator program uses its own 700/1 goal and its own cohort", () => {
  const edu = buildBenchmarkCurves(EDUCATOR_COHORT).products["educator program"];
  assert.deepEqual(edu.goal, { maxCpp: 700, minPurchases: 1 });
  assert.deepEqual(edu.cohortAdIds, ["EA", "EB", "EC"]);
  // day 1: EA has spent 600 without a purchase, which is read as a CPP of at least 600
  assert.equal(edu.days[0].ceiling, 600);
});

test("educator program's curve is never blended with the other products", () => {
  const alone = buildBenchmarkCurves(EDUCATOR_COHORT).products["educator program"];
  // An mpedia ad whose numbers would pass educator's goal (650 CPP, >= 1 purchase) plus a full
  // mpedia cohort must change nothing about educator's curve.
  const mpediaLookalike = adWithCpp("M-650", "mpedia", Array(10).fill(650));
  const mixed = buildBenchmarkCurves([...EDUCATOR_COHORT, ...MPEDIA_COHORT, ...mpediaLookalike]);
  assert.deepEqual(mixed.products["educator program"], alone);
  assert.ok(!mixed.products.mpedia.cohortAdIds.includes("M-650"));
});

test("a thin educator cohort stays low confidence even when others have plenty — no fallback", () => {
  const thin = EDUCATOR_COHORT.filter((r) => r.adId !== "EC");
  const { products } = buildBenchmarkCurves([...thin, ...MPEDIA_COHORT]);
  assert.ok(products["educator program"].days.every((d) => d.confidence === CONFIDENCE.LOW && d.ceiling === null));
  assert.ok(products.mpedia.days.every((d) => d.confidence === CONFIDENCE.OK));
});

test("curves are recomputed on demand as new ads join the cohort", () => {
  const before = buildBenchmarkCurves(MPEDIA_COHORT);
  const newWinner = adWithCpp("G", "mpedia", [400, 300, 280, 270, 260, 250, 250, 250, 250, 250]);
  const after = buildBenchmarkCurves([...MPEDIA_COHORT, ...newWinner]);
  assert.equal(after.products.mpedia.cohortSize, 4);
  assert.equal(after.products.mpedia.days[0].ceiling, 400);
  // the earlier result is a plain value, untouched by the later call
  assert.equal(before.products.mpedia.days[0].ceiling, 350);
  assert.equal(before.products.mpedia.cohortSize, 3);
});

test("goals are injectable, e.g. the live thresholds from D1", () => {
  const stricter = { mpedia: { maxCpp: 260, minPurchases: 17 } };
  const { products } = buildBenchmarkCurves(MPEDIA_COHORT, { goals: stricter });
  assert.deepEqual(Object.keys(products), ["mpedia"]);
  assert.deepEqual(products.mpedia.cohortAdIds, ["A", "B"]); // C finished at 275
});

test("margin tapers linearly from earlyStart to standard over taperDays", () => {
  const { margin } = resolveConfig();
  const expected = [0.3, 0.26, 0.22, 0.18, 0.14, 0.1, 0.1, 0.1, 0.1, 0.1];
  expected.forEach((m, i) => close(marginForDay(i + 1, margin), m, `day ${i + 1}`));

  const custom = resolveConfig({ margin: { earlyStart: 0.5, taperDays: 4 } }).margin;
  [0.5, 0.4, 0.3, 0.2, 0.1].forEach((m, i) => close(marginForDay(i + 1, custom), m, `custom day ${i + 1}`));

  const none = resolveConfig({ margin: { taperDays: 0 } }).margin;
  close(marginForDay(1, none), 0.1);
});

test("margin can be set in explicit steps instead of a linear taper", () => {
  const { margin } = resolveConfig({ margin: { steps: [0.4, 0.4, 0.2] } });
  assert.deepEqual([1, 2, 3, 4, 10].map((d) => marginForDay(d, margin)), [0.4, 0.4, 0.2, 0.1, 0.1]);
});
