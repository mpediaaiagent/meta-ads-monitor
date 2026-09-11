import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarks, evaluateAd, resolveConfig, VERDICT, REASON, STATUS, BENCHMARK_KIND } from "../src/index.js";
import { ad, dailyFromCumulative, dailyWithCpp, RAMP } from "./fixtures.js";

// Benchmark per day (days 1–9): 350 320 300 290 280 275 275 275 275, so with the 10% margin
// the Pause line is:           385 352 330 319 308 302.5 302.5 302.5 302.5
// First-purchase limit: A and B bought on day 1 (600, 700) and C on day 2 (₹640 by then) → 700.
const COHORT = [
  ad("A", "trubuddy", dailyWithCpp([300, 290, 280, 270, 260, 250, 250, 250, 250, 250, 250], RAMP)),
  ad("B", "trubuddy", dailyWithCpp([350, 320, 300, 290, 280, 270, 265, 260, 255, 250, 250], RAMP)),
  ad("C", "trubuddy", dailyFromCumulative([[300, 0], [640, 2], [1620, 6], [2200, 8], [2750, 10], [3300, 12], [3850, 14], [4400, 16], [4950, 18], [5500, 20], [6050, 22]])),
];
const TB = buildBenchmarks(COHORT).products.trubuddy;

const verdicts = (r) => r.days.map((d) => d.verdict);

test("the benchmark fixture is what the comments say", () => {
  assert.deepEqual(TB.days.map((d) => d.upperBound), [385, 352, 330, 319, 308, 302.5, 302.5, 302.5, 302.5]);
  assert.equal(TB.firstPurchaseLimit.value, 700);
});

test("no purchase yet: Keep while spend is within the first-purchase limit, Pause once it goes past", () => {
  const r = evaluateAd(dailyFromCumulative([[300, 0], [700, 0], [700.01, 0]]), TB);
  assert.deepEqual(verdicts(r), [VERDICT.KEEP, VERDICT.KEEP, VERDICT.PAUSE]); // exactly ₹700 is not above
  assert.deepEqual(r.days.map((d) => d.reason), [REASON.WITHIN_FIRST_PURCHASE_LIMIT, REASON.WITHIN_FIRST_PURCHASE_LIMIT, REASON.SPEND_WITHOUT_PURCHASE]);
  assert.deepEqual(r.days[2].benchmark, { kind: BENCHMARK_KIND.FIRST_PURCHASE_LIMIT, limit: 700, sampleSize: 3 });
  assert.equal(r.days[2].cumCpp, null);
});

test("the first-purchase limit has no margin on it", () => {
  const r = evaluateAd(dailyFromCumulative([[710, 0]]), TB);
  assert.equal(r.verdict, VERDICT.PAUSE); // 710 is within 700 + 10%, but no margin applies here
});

test("with purchases: Pause only when cumulative CPP is above that day's benchmark + 10%", () => {
  // day 6 line is 302.5: 300 keeps, 302.5 (exactly on it) keeps, 303 pauses
  const at = (cpp) => evaluateAd(dailyWithCpp([100, 100, 100, 100, 100, cpp], RAMP), TB);
  assert.equal(at(300).verdict, VERDICT.KEEP);
  assert.equal(at(302.5).verdict, VERDICT.KEEP);
  assert.equal(at(303).verdict, VERDICT.PAUSE);
  assert.equal(at(303).reason, REASON.CPP_ABOVE_BENCHMARK);
  assert.deepEqual(at(303).days[5].benchmark, { kind: BENCHMARK_KIND.CPP, ceiling: 275, margin: 0.1, upperBound: 302.5, sampleSize: 3 });
});

test("each day is judged against that day's own benchmark", () => {
  // a flat ₹340 CPP is fine early (day-1 line 385, day-2 352) and too high from day 3 (330)
  const r = evaluateAd(dailyWithCpp([340, 340, 340, 340], RAMP), TB);
  assert.deepEqual(verdicts(r), [VERDICT.KEEP, VERDICT.KEEP, VERDICT.PAUSE, VERDICT.PAUSE]);
  assert.deepEqual(r.days.map((d) => d.cumCpp), [340, 340, 340, 340]);
});

test("once an ad has purchased, only its CPP counts — heavy pre-purchase spend no longer pauses it", () => {
  // ₹900 before its first purchase (over the ₹700 limit) → Pause on day 2; then it converts well
  const r = evaluateAd(dailyFromCumulative([[400, 0], [900, 0], [1000, 4], [1100, 5]]), TB);
  assert.deepEqual(verdicts(r), [VERDICT.KEEP, VERDICT.PAUSE, VERDICT.KEEP, VERDICT.KEEP]);
  assert.equal(r.days[2].reason, REASON.WITHIN_CPP_BENCHMARK); // 250 CPP vs 330
});

test("the ad's current verdict is its latest day's", () => {
  const r = evaluateAd(dailyWithCpp([340, 340, 340], RAMP), TB);
  assert.equal(r.status, STATUS.INCUBATION);
  assert.equal(r.ageDays, 3);
  assert.equal(r.firstSpendDate, "2026-08-01");
  assert.equal(r.verdict, VERDICT.PAUSE);
  assert.equal(r.reason, REASON.CPP_ABOVE_BENCHMARK);
});

test("past day 9 the ad is out of incubation: no current verdict, but its days 1–9 are still shown", () => {
  const r = evaluateAd(dailyWithCpp([300, 300, 300, 300, 300, 300, 300, 300, 300, 300], RAMP), TB);
  assert.equal(r.status, STATUS.PAST_INCUBATION);
  assert.equal(r.ageDays, 10);
  assert.equal(r.verdict, null);
  assert.equal(r.reason, null);
  assert.equal(r.days.length, 9);
});

test("days without delivery at the end of the window still age the ad", () => {
  const daily = dailyWithCpp([300, 300], RAMP);
  assert.equal(evaluateAd(daily, TB).status, STATUS.INCUBATION);
  const r = evaluateAd(daily, TB, { through: "2026-08-10" });
  assert.equal(r.ageDays, 10);
  assert.equal(r.status, STATUS.PAST_INCUBATION);
});

test("an ad that hasn't spent yet has no verdict", () => {
  const r = evaluateAd([{ date: "2026-08-01", spend: 0, purchases: 0 }], TB);
  assert.deepEqual(r, { status: STATUS.NOT_STARTED, ageDays: 0, firstSpendDate: null, verdict: null, reason: null, days: [] });
});

test("nothing to compare against means Keep, labelled no_benchmark", () => {
  const empty = buildBenchmarks([]).products.gulu;
  const noPurchase = evaluateAd(dailyFromCumulative([[5000, 0]]), empty);
  const withPurchase = evaluateAd(dailyWithCpp([5000], [1]), empty);
  const noProduct = evaluateAd(dailyWithCpp([5000], [1]), null);
  for (const r of [noPurchase, withPurchase, noProduct]) {
    assert.equal(r.verdict, VERDICT.KEEP);
    assert.equal(r.reason, REASON.NO_BENCHMARK);
  }
});

test("a day with a purchase but no successful ad that had one by then is Keep / no_benchmark", () => {
  // successful ads that only bought from day 3 on: day 1–2 have no CPP benchmark
  const late = buildBenchmarks([ad("L", "trubuddy", dailyFromCumulative([[100, 0], [200, 0], [300, 1], ...Array(8).fill([400, 2])]))]).products.trubuddy;
  const r = evaluateAd(dailyWithCpp([9999, 9999, 9999], [1, 1, 1]), late);
  assert.deepEqual(r.days.map((d) => d.reason), [REASON.NO_BENCHMARK, REASON.NO_BENCHMARK, REASON.CPP_ABOVE_BENCHMARK]);
});

test("margin and incubation length are settings", () => {
  const wide = buildBenchmarks(COHORT, { cppMargin: 0.2 }).products.trubuddy;
  assert.equal(evaluateAd(dailyWithCpp([100, 100, 100, 100, 100, 320], RAMP), wide, { cppMargin: 0.2 }).verdict, VERDICT.KEEP);
  const short = evaluateAd(dailyWithCpp([300, 300, 300, 300, 300, 300], RAMP), TB, { incubationMaxDay: 5, successMinDays: 6 });
  assert.equal(short.status, STATUS.PAST_INCUBATION);
  assert.equal(short.days.length, 5);
});

test("the output has a fixed shape and is plain JSON", () => {
  const r = evaluateAd(dailyFromCumulative([[300, 0], [600, 2]]), TB);
  assert.deepEqual(Object.keys(r), ["status", "ageDays", "firstSpendDate", "verdict", "reason", "days"]);
  assert.deepEqual(Object.keys(r.days[0]), ["day", "date", "cumSpend", "cumPurchases", "cumCpp", "verdict", "reason", "benchmark"]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test("config typos and nonsense are rejected", () => {
  assert.throws(() => resolveConfig({ margin: 0.1 }), /Unknown config key\(s\): margin/);
  assert.throws(() => resolveConfig({ cppMargin: -1 }), /cppMargin/);
  assert.throws(() => resolveConfig({ successMinDays: 9 }), /successMinDays/);
  assert.throws(() => resolveConfig({ ceilingStatistic: "max" }), /ceilingStatistic/);
  assert.throws(() => resolveConfig({ products: [{ product: "x", pattern: "x" }] }), /RegExp/);
});
