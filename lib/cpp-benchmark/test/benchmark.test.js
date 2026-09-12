import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarks, spendBeforeFirstPurchase, alignFromFirstSpend, STATISTICS } from "../src/index.js";
import { ad, dailyFromCumulative, dailyWithCpp, RAMP } from "./fixtures.js";

// Three successful trubuddy ads. Their cumulative CPP per day (days 1–9):
//   A: 300 290 280 270 260 250 250 250 250
//   B: 350 320 300 290 280 270 265 260 255
//   C: 250 260 270 275 275 275 275 275 275
// so the highest (the benchmark) per day is: 350 320 300 290 280 275 275 275 275
const COHORT = [
  ad("A", "10Sept-trubuddy-page-demographics-campaign", dailyWithCpp([300, 290, 280, 270, 260, 250, 250, 250, 250, 250, 250], RAMP)),
  ad("B", "9Sept-trubuddy-demographics-campaign", dailyWithCpp([350, 320, 300, 290, 280, 270, 265, 260, 255, 250, 250], RAMP)),
  ad("C", "8Sept-trubuddy-testing-campaign", dailyWithCpp([250, 260, 270, 275, 275, 275, 275, 275, 275, 275, 275], RAMP)),
];
const CEILINGS = [350, 320, 300, 290, 280, 275, 275, 275, 275];

test("each day's CPP benchmark is the highest cumulative CPP of that product's successful ads, plus 10%", () => {
  const { products } = buildBenchmarks(COHORT);
  const t = products.trubuddy;
  assert.equal(t.cohortSize, 3);
  assert.equal(t.days.length, 9, "only the 9 incubation days");
  assert.deepEqual(t.days.map((d) => d.ceiling), CEILINGS);
  assert.deepEqual(t.days.map((d) => d.upperBound), CEILINGS.map((c) => Math.round(c * 110) / 100));
  assert.ok(t.days.every((d) => d.margin === 0.1 && d.sampleSize === 3));
});

test("days where a successful ad had no purchase yet are left out of that day's CPP sample", () => {
  const slow = ad("S", "trubuddy-slow", dailyFromCumulative([[400, 0], [700, 0], [900, 2], [1000, 3], [1100, 4], [1200, 5], [1300, 6], [1400, 7], [1500, 8], [1600, 9], [1700, 10]]));
  const { products } = buildBenchmarks([...COHORT, slow]);
  const d = products.trubuddy.days;
  assert.equal(d[0].sampleSize, 3);
  assert.equal(d[0].ceiling, 350); // S's day-1 ₹400 with no purchase is not a CPP
  assert.equal(d[2].sampleSize, 4);
  assert.equal(d[2].ceiling, 450); // day 3: S at 900 / 2
});

test("first-purchase limit: the most any successful ad spent up to and including its first-purchase day", () => {
  const ads = [
    ad("P1", "trubuddy", dailyFromCumulative([[200, 0], [450, 1], [600, 2], ...Array(8).fill([700, 3])])), // 450
    ad("P2", "trubuddy", dailyFromCumulative([[300, 1], ...Array(10).fill([400, 2])])), // bought on day 1: 300
    ad("P3", "trubuddy", dailyFromCumulative([[100, 0], [250, 0], [380, 0], [520, 1], ...Array(7).fill([600, 1])])), // 520
  ];
  const { products } = buildBenchmarks(ads);
  assert.deepEqual(products.trubuddy.firstPurchaseLimit, { value: 520, sampleSize: 3, source: "benchmark", derived: 520 });
});

test("a successful ad with no purchase by day 9 contributes what it had spent by day 9", () => {
  // bought for the first time on day 12, after ₹1,200 — only the first 9 days (₹900) count
  const late = ad("L", "trubuddy", dailyFromCumulative(Array.from({ length: 12 }, (_, i) => [100 * (i + 1), i === 11 ? 1 : 0])));
  const never = ad("N", "trubuddy", dailyFromCumulative(Array.from({ length: 11 }, (_, i) => [50 * (i + 1), 0])));
  const { products } = buildBenchmarks([late, never]);
  assert.deepEqual(products.trubuddy.firstPurchaseLimit, { value: 900, sampleSize: 2, source: "benchmark", derived: 900 });
  assert.ok(products.trubuddy.days.every((d) => d.ceiling === null), "neither had a CPP in days 1–9");
});

test("the edited spend-with-no-purchase threshold replaces the derived first-purchase limit", () => {
  const ads = [
    ad("P1", "trubuddy", dailyFromCumulative([[200, 0], [450, 1], [600, 2], ...Array(8).fill([700, 3])])),
    ad("P3", "trubuddy", dailyFromCumulative([[100, 0], [250, 0], [380, 0], [520, 1], ...Array(7).fill([600, 1])])),
  ];
  const auto = buildBenchmarks(ads).products.trubuddy;
  assert.deepEqual(auto.firstPurchaseLimit, { value: 520, sampleSize: 2, source: "benchmark", derived: 520 });
  assert.equal(auto.maxSpendNoPurchase, null);

  const edited = buildBenchmarks(ads, { maxSpendNoPurchaseByProduct: { trubuddy: 300 } }).products.trubuddy;
  assert.equal(edited.maxSpendNoPurchase, 300);
  assert.deepEqual(edited.firstPurchaseLimit, { value: 300, sampleSize: 2, source: "threshold", derived: 520 });
  assert.deepEqual(edited.days, auto.days, "the CPP benchmark is untouched by it");
});

test("a blank spend-with-no-purchase threshold leaves the derived limit in charge", () => {
  const ads = [ad("P", "trubuddy", dailyFromCumulative([[200, 0], [450, 1], ...Array(9).fill([700, 3])]))];
  // a NULL column and a product with no row at all are the two ways the dashboard says "blank"
  for (const overrides of [{ trubuddy: null }, {}, null]) {
    const b = buildBenchmarks(ads, { maxSpendNoPurchaseByProduct: overrides }).products.trubuddy;
    assert.equal(b.firstPurchaseLimit.value, 450, `${JSON.stringify(overrides)} must not clear the derived limit`);
    assert.equal(b.firstPurchaseLimit.source, "benchmark");
  }
  // an undefined value is a typo, not a blank, and is rejected rather than silently ignored
  assert.throws(() => buildBenchmarks(ads, { maxSpendNoPurchaseByProduct: { trubuddy: undefined } }), RangeError);
});

test("the threshold sets a first-purchase limit even for a product with no successful ads", () => {
  const b = buildBenchmarks(COHORT, { maxSpendNoPurchaseByProduct: { gulu: 400 } }).products.gulu;
  assert.equal(b.cohortSize, 0);
  assert.deepEqual(b.firstPurchaseLimit, { value: 400, sampleSize: 0, source: "threshold", derived: null });
});

test("each product's spend-with-no-purchase threshold is its own", () => {
  const { products } = buildBenchmarks(COHORT, { maxSpendNoPurchaseByProduct: { mpedia: 900 } });
  assert.equal(products.mpedia.firstPurchaseLimit.value, 900);
  assert.equal(products.trubuddy.firstPurchaseLimit.source, "benchmark", "trubuddy keeps its own derived limit");
});

test("spendBeforeFirstPurchase reads only the incubation window", () => {
  const days = alignFromFirstSpend(dailyFromCumulative([[100, 0], [200, 0], [300, 1], [400, 1]]));
  assert.equal(spendBeforeFirstPurchase(days, 9), 300);
  assert.equal(spendBeforeFirstPurchase(days, 2), 200);
  assert.equal(spendBeforeFirstPurchase([], 9), null);
});

test("products never mix — educator program's numbers don't touch trubuddy's, or the reverse", () => {
  const educator = [
    ad("E1", "25August-period-educator-certificate-campaign", dailyFromCumulative([[900, 1], ...Array(10).fill([1400, 2])])),
    ad("E2", "educator-webinar", dailyFromCumulative([[2000, 0], [2500, 1], ...Array(9).fill([2600, 1])])),
  ];
  const alone = buildBenchmarks(COHORT).products.trubuddy;
  const mixed = buildBenchmarks([...COHORT, ...educator]);
  assert.deepEqual(mixed.products.trubuddy, alone);
  assert.equal(mixed.products["educator program"].cohortSize, 2);
  assert.equal(mixed.products["educator program"].days[0].ceiling, 900);
  assert.deepEqual(mixed.products["educator program"].firstPurchaseLimit, { value: 2500, sampleSize: 2, source: "benchmark", derived: 2500 });
});

test("a product with no successful ads has no benchmark at all", () => {
  const { products } = buildBenchmarks(COHORT);
  for (const name of ["mpedia", "gulu", "educator program", "adi anku"]) {
    assert.equal(products[name].cohortSize, 0);
    assert.ok(products[name].days.every((d) => d.ceiling === null && d.upperBound === null && d.sampleSize === 0));
    assert.deepEqual(products[name].firstPurchaseLimit, { value: null, sampleSize: 0, source: "benchmark", derived: null });
  }
});

test("unclassified and never-spending ads are reported, not silently used", () => {
  const out = buildBenchmarks([
    ...COHORT,
    ad("U", "brand-campaign", dailyWithCpp([100], [1])),
    ad("Z", "trubuddy", [{ date: "2026-08-01", spend: 0, purchases: 0 }]),
  ]);
  assert.deepEqual(out.unclassifiedAdIds, ["U"]);
  assert.deepEqual(out.neverSpentAdIds, ["Z"]);
  assert.equal(out.products.trubuddy.cohortSize, 3);
});

test("the statistics are swappable without touching the logic", () => {
  const p50 = buildBenchmarks(COHORT, { ceilingStatistic: STATISTICS.percentile(50) }).products.trubuddy;
  assert.equal(p50.days[0].ceiling, 300); // day 1 sample is [300, 350, 250]
  assert.equal(buildBenchmarks(COHORT, { cppMargin: 0.2 }).products.trubuddy.days[0].upperBound, 420);
});

test("percentile interpolates like PERCENTILE.INC and rejects bad input", () => {
  assert.equal(STATISTICS.percentile(50).compute([4, 1, 3, 2]), 2.5);
  assert.equal(STATISTICS.percentile(80).compute([10, 20, 30, 40, 50]), 42);
  assert.throws(() => STATISTICS.percentile(101), RangeError);
  assert.throws(() => STATISTICS.max.compute([]), RangeError);
});

test("the result is plain JSON", () => {
  const out = buildBenchmarks(COHORT);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
  assert.equal(out.config.ceilingStatistic, "max");
  assert.equal(out.config.cppMargin, 0.1);
});
