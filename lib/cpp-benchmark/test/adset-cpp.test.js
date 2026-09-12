import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAdsetBenchmarks, adsetCpp, adsetSpendBeforeFirstPurchase, resolveConfig, VERDICT, REASON } from "../src/index.js";
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

test("days 1 and 2 are immune: no adset-level rule reads them", () => {
  for (const days of [1, 2]) {
    const daily = dailyWithCpp(Array(days).fill(9999), Array.from({ length: days }, (_, i) => i + 1));
    const r = adsetCpp([live(daily)], TB, CFG);
    assert.equal(r.verdict, null, `day ${days} must not be flagged`);
    assert.equal(r.reason, REASON.IMMUNE_EARLY_DAYS);
  }
});

test("an adset is Pause when its own cumulative CPP is above that day's line, whatever its ads did", () => {
  // day 3 line is 286: 280 keeps, exactly 286 keeps, 287 pauses (day 3 is the first judgeable one)
  const at = (cpp) => adsetCpp([live(dailyWithCpp([100, 100, cpp], [2, 4, 6]))], TB, CFG);
  assert.equal(at(280).verdict, VERDICT.KEEP);
  assert.equal(at(286).verdict, VERDICT.KEEP);
  assert.equal(at(287).verdict, VERDICT.PAUSE);
  assert.equal(at(287).reason, REASON.ADSET_CPP_ABOVE_BENCHMARK);
  assert.equal(at(280).reason, REASON.WITHIN_ADSET_CPP_BENCHMARK);
});

test("every ad's spend and purchases are summed before the adset's CPP is taken", () => {
  // two ads, each ₹400 / 1 purchase → adset is ₹800 / 2 = CPP 400, above the day-3 line of 286
  const one = dailyFromCumulative([[400, 1], [400, 1], [400, 1]]);
  const r = adsetCpp([live(one), live(one)], TB, CFG);
  assert.equal(r.day, 3);
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
  const r = adsetCpp([live(dailyFromCumulative([[900, 0], [1800, 0], [2700, 0]]))], TB, CFG);
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
  const r = adsetCpp([live(dailyWithCpp([9999, 9999, 9999], [1, 2, 3]))], gulu, CFG);
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

// ---- spend before the adset's first purchase ----

// Past adsets that each bought on day 1, having spent 2 purchases' worth: X 400, Y 600, Z 500.
// The most any of them spent before converting is 600, so the line is 600 + 10% = 660.
const SPEND_PAST = [
  past("X", "trubuddy-a", dailyFromCumulative([[400, 2], ...Array(10).fill([800, 4])])),
  past("Y", "trubuddy-b", dailyFromCumulative([[600, 2], ...Array(10).fill([1000, 4])])),
  past("Z", "trubuddy-c", dailyFromCumulative([[500, 2], ...Array(10).fill([900, 4])])),
];
const SP = buildAdsetBenchmarks(SPEND_PAST).products.trubuddy;

test("the adset first-purchase spend limit is the worst past adset's, plus the margin", () => {
  assert.deepEqual(SP.firstPurchaseSpendLimit, { value: 660, ceiling: 600, margin: 0.1, sampleSize: 3 });
});

test("an adset with no purchase is Pause once it outspends that limit", () => {
  // day 3, the first day an adset-level rule may look at it
  const at = (spend) => adsetSpendBeforeFirstPurchase([live(dailyFromCumulative([[10, 0], [20, 0], [spend, 0]]))], SP, CFG);
  assert.equal(at(600).verdict, VERDICT.KEEP);
  assert.equal(at(660).verdict, VERDICT.KEEP, "exactly on the line is not above it");
  assert.equal(at(661).verdict, VERDICT.PAUSE);
  assert.equal(at(661).reason, REASON.ADSET_SPEND_WITHOUT_PURCHASE);
  assert.equal(at(600).reason, REASON.WITHIN_ADSET_FIRST_PURCHASE_LIMIT);
});

test("every ad's spend counts towards the adset's pre-purchase total", () => {
  const one = dailyFromCumulative([[400, 0], [400, 0], [400, 0]]);
  const r = adsetSpendBeforeFirstPurchase([live(one), live(one)], SP, CFG);
  assert.equal(r.cumSpend, 800);
  assert.equal(r.verdict, VERDICT.PAUSE);
});

test("once the adset has converted this rule stands down, however much it spent getting there", () => {
  const r = adsetSpendBeforeFirstPurchase([live(dailyFromCumulative([[5000, 1], [5000, 1], [5000, 1]]))], SP, CFG);
  assert.equal(r.verdict, null, "a converted adset is the CPP rule's business, not this one's");
  assert.equal(r.reason, REASON.ADSET_FIRST_PURCHASE_IN_TIME);
});

test("past the incubation days the day-limit rule takes over, so this one stands down", () => {
  const long = dailyFromCumulative(Array.from({ length: 10 }, (_, i) => [1000 * (i + 1), 0]));
  const r = adsetSpendBeforeFirstPurchase([live(long)], SP, CFG);
  assert.equal(r.verdict, null);
  assert.equal(r.reason, REASON.NO_BENCHMARK);
});

test("a product with no past adsets has no spend limit, so nothing is flagged", () => {
  const gulu = buildAdsetBenchmarks(SPEND_PAST).products.gulu;
  assert.equal(gulu.firstPurchaseSpendLimit.value, null);
  const r = adsetSpendBeforeFirstPurchase([live(dailyFromCumulative([[1, 0], [2, 0], [99999, 0]]))], gulu, CFG);
  assert.equal(r.verdict, null);
  assert.equal(r.reason, REASON.NO_BENCHMARK);
});

test("the CPP rule and the spend rule are mutually exclusive", () => {
  const noBuy = [live(dailyFromCumulative([[10, 0], [20, 0], [700, 0]]))];
  assert.equal(adsetCpp(noBuy, SP, CFG).verdict, null, "no purchase: the CPP rule stands down");
  assert.equal(adsetSpendBeforeFirstPurchase(noBuy, SP, CFG).verdict, VERDICT.PAUSE);

  const bought = [live(dailyFromCumulative([[10, 1], [20, 1], [700, 1]]))];
  assert.notEqual(adsetCpp(bought, SP, CFG).verdict, null, "purchased: the CPP rule applies");
  assert.equal(adsetSpendBeforeFirstPurchase(bought, SP, CFG).verdict, null);
});
