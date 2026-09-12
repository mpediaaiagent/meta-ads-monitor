import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdsetBenchmarks, adsetCpp, resolveConfig, VERDICT, REASON } from "../src/index.js";
import { dailyFromCumulative, dailyWithCpp, RAMP } from "./fixtures.js";

const CFG = resolveConfig();

/** One past adset for buildAdsetBenchmarks. */
const past = (adsetKey, campaignName, daily) => ({ adsetKey, campaignName, daily });
/** One live ad in the adset being judged; adsetCpp only ever reads `daily`. */
const live = (daily) => ({ daily });

// Three past trubuddy adsets. Cumulative CPP per day (days 1–3):
//   X: 200 210 220
//   Y: 300 280 260
//   Z: 250 240 230
// so the highest per day is 300 280 260, and with the 10% margin the Pause line is 330 308 286.
const PAST = [
  past("X", "trubuddy-a", dailyWithCpp([200, 210, 220, 220, 220, 220, 220, 220, 220, 220, 220], RAMP)),
  past("Y", "trubuddy-b", dailyWithCpp([300, 280, 260, 255, 250, 250, 250, 250, 250, 250, 250], RAMP)),
  past("Z", "trubuddy-c", dailyWithCpp([250, 240, 230, 230, 230, 230, 230, 230, 230, 230, 230], RAMP)),
];
const TB = buildAdsetBenchmarks(PAST).products.trubuddy;

test("the adset benchmark fixture is what the comments say", () => {
  assert.equal(TB.cohortSize, 3);
  assert.deepEqual(TB.days.slice(0, 3).map((d) => d.ceiling), [300, 280, 260]);
  assert.deepEqual(TB.days.slice(0, 3).map((d) => d.upperBound), [330, 308, 286]);
});

test("an adset is Pause when its own cumulative CPP is above that day's line, whatever its ads did", () => {
  // day 2 line is 308: 300 keeps, exactly 308 keeps, 309 pauses
  const at = (cpp) => adsetCpp([live(dailyWithCpp([100, cpp], [2, 4]))], TB, CFG);
  assert.equal(at(300).verdict, VERDICT.KEEP);
  assert.equal(at(308).verdict, VERDICT.KEEP);
  assert.equal(at(309).verdict, VERDICT.PAUSE);
  assert.equal(at(309).reason, REASON.ADSET_CPP_ABOVE_BENCHMARK);
  assert.equal(at(300).reason, REASON.WITHIN_ADSET_CPP_BENCHMARK);
});

test("every ad's spend and purchases are summed before the adset's CPP is taken", () => {
  // two ads, each ₹400 / 1 purchase on day 1 → adset day 1 is ₹800 / 2 = CPP 400, above the 330 line
  const two = [
    live(dailyFromCumulative([[400, 1]])),
    live(dailyFromCumulative([[400, 1]])),
  ];
  const r = adsetCpp(two, TB, CFG);
  assert.equal(r.day, 1);
  assert.equal(r.cumSpend, 800);
  assert.equal(r.cumPurchases, 2);
  assert.equal(r.cumCpp, 400);
  assert.equal(r.verdict, VERDICT.PAUSE);
});

test("the adset's day 1 is the first day ANY of its ads spent", () => {
  const ads = [
    live([{ date: "2026-08-01", spend: 100, purchases: 1 }]),
    live([{ date: "2026-08-03", spend: 100, purchases: 1 }]),
  ];
  const r = adsetCpp(ads, TB, CFG, { through: "2026-08-03" });
  assert.equal(r.day, 3, "2026-08-01 is day 1, so 08-03 is day 3");
  assert.equal(r.cumCpp, 100);
});

test("no purchase yet means no CPP to compare — this rule stands down rather than guessing", () => {
  const r = adsetCpp([live(dailyFromCumulative([[900, 0], [1800, 0]]))], TB, CFG);
  assert.equal(r.verdict, null);
  assert.equal(r.reason, REASON.NO_BENCHMARK);
  assert.equal(r.cumCpp, null);
});

test("past the incubation days there is no line left to read", () => {
  const long = dailyWithCpp(Array(10).fill(400), Array.from({ length: 10 }, (_, i) => i + 1));
  const r = adsetCpp([live(long)], TB, CFG);
  assert.equal(r.verdict, null, "day 10 is past incubationMaxDay 9");
  assert.equal(r.reason, REASON.NO_BENCHMARK);
});

test("a product with no past adsets has no line, so nothing is flagged", () => {
  const gulu = buildAdsetBenchmarks(PAST).products.gulu;
  assert.equal(gulu.cohortSize, 0);
  const r = adsetCpp([live(dailyWithCpp([9999], [1]))], gulu, CFG);
  assert.equal(r.verdict, null);
  assert.equal(r.reason, REASON.NO_BENCHMARK);
});

test("an adset that never spent has no verdict", () => {
  const r = adsetCpp([live([{ date: "2026-08-01", spend: 0, purchases: 0 }])], TB, CFG);
  assert.equal(r.verdict, null);
  assert.equal(r.day, null);
});

test("the CPP threshold picks the adset cohort too, so a past flop can't raise the line", () => {
  const flop = past("F", "trubuddy-flop", dailyWithCpp([900, 900, 900, 900, 900, 900, 900, 900, 900, 900, 900], RAMP));
  const unfiltered = buildAdsetBenchmarks([...PAST, flop]).products.trubuddy;
  assert.equal(unfiltered.days[0].ceiling, 900, "with no threshold the flop sets day 1");

  const filtered = buildAdsetBenchmarks([...PAST, flop], { maxCppByProduct: { trubuddy: 280 } }).products.trubuddy;
  assert.equal(filtered.candidates, 4);
  assert.equal(filtered.cohortSize, 3, "the flop's day-10 CPP of 900 is over the 280 threshold");
  assert.equal(filtered.days[0].ceiling, 300, "back to Y's 300");
});

test("products never mix at adset level either", () => {
  const gulu = past("G", "gulu-one", dailyWithCpp([800, 800, 800, 800, 800, 800, 800, 800, 800, 800, 800], RAMP));
  const { products } = buildAdsetBenchmarks([...PAST, gulu]);
  assert.equal(products.trubuddy.days[0].ceiling, 300, "gulu's 800 doesn't touch trubuddy");
  assert.equal(products.gulu.days[0].ceiling, 800);
});

test("an unclassified campaign is reported, not silently counted", () => {
  const out = buildAdsetBenchmarks([...PAST, past("U", "brand-campaign", dailyWithCpp([100], [1]))]);
  assert.deepEqual(out.unclassifiedAdsetKeys, ["U"]);
  assert.equal(out.products.trubuddy.cohortSize, 3);
});

test("the result is plain JSON", () => {
  const out = buildAdsetBenchmarks(PAST);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out);
});
