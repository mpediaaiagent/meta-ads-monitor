import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarks, judgeWindow, rollUpAdset, isRunning, adsetFirstPurchase, firstPurchaseDay, cppOnDay, alignFromFirstSpend, resolveConfig, VERDICT, REASON, BENCHMARK_KIND } from "../src/index.js";
import { ad, dailyFromCumulative, dailyWithCpp, RAMP } from "./fixtures.js";

// Three trubuddy ads that ran 11 days, finishing day 10 at cumulative CPP 250, 280 and 320.
const CHEAP = ad("CHEAP", "trubuddy", dailyWithCpp([300, 290, 280, 270, 260, 250, 250, 250, 250, 250, 250], RAMP));
const EDGE = ad("EDGE", "trubuddy", dailyWithCpp([320, 300, 300, 290, 290, 285, 285, 280, 280, 280, 280], RAMP));
const DEAR = ad("DEAR", "trubuddy", dailyWithCpp([900, 700, 500, 450, 400, 380, 360, 340, 330, 320, 320], RAMP));
// ran 11 days but had no purchase until day 11
const NOBUY = ad("NOBUY", "trubuddy", dailyFromCumulative([...Array.from({ length: 10 }, (_, i) => [100 * (i + 1), 0]), [1100, 1]]));

test("a product's threshold decides which 11+ day ads count: day-10 cumulative CPP at or under it", () => {
  const b = buildBenchmarks([CHEAP, EDGE, DEAR, NOBUY], { maxCppByProduct: { trubuddy: 280 } }).products.trubuddy;
  assert.equal(b.maxCpp, 280);
  assert.equal(b.candidates, 4);
  assert.equal(b.cohortSize, 2, "CHEAP (250) and EDGE (exactly 280) pass; DEAR (320) and NOBUY (no purchase by day 10) don't");
  // DEAR's ₹900 day-1 CPP no longer sets the day-1 line
  assert.equal(b.days[0].ceiling, 320);
  // NOBUY no longer sets the first-purchase limit either
  assert.equal(b.firstPurchaseLimit.value, 640);
});

test("without a threshold every 11+ day ad counts, as before", () => {
  const b = buildBenchmarks([CHEAP, EDGE, DEAR, NOBUY]).products.trubuddy;
  assert.equal(b.maxCpp, null);
  assert.equal(b.cohortSize, 4);
  assert.equal(b.days[0].ceiling, 900);
  assert.equal(b.firstPurchaseLimit.value, 1800);
});

test("thresholds are per product, and a product without one is unfiltered", () => {
  const edu = ad("EDU", "educator-webinar", dailyFromCumulative([[650, 1], ...Array(10).fill([1300, 2])])); // day-10 CPP 650
  const out = buildBenchmarks([CHEAP, DEAR, edu], { maxCppByProduct: { trubuddy: 280, "educator program": 700 } });
  assert.equal(out.products.trubuddy.cohortSize, 1);
  assert.equal(out.products["educator program"].cohortSize, 1, "650 is within educator's 700");
  const noEdu = buildBenchmarks([CHEAP, DEAR, edu], { maxCppByProduct: { trubuddy: 280 } });
  assert.equal(noEdu.products["educator program"].maxCpp, null);
  assert.equal(noEdu.products["educator program"].cohortSize, 1);
});

test("the CPP day is a setting", () => {
  const days = alignFromFirstSpend(DEAR.daily);
  assert.equal(cppOnDay(days, 10), 320);
  assert.equal(cppOnDay(days, 3), 500);
  assert.equal(cppOnDay(alignFromFirstSpend(NOBUY.daily), 10), null);
  const b = buildBenchmarks([DEAR], { maxCppByProduct: { trubuddy: 330 }, successCppDay: 9 }).products.trubuddy;
  assert.equal(b.cohortSize, 1, "day-9 CPP is 330");
  assert.throws(() => resolveConfig({ successCppDay: 11 }), /successCppDay/);
  assert.throws(() => resolveConfig({ maxCppByProduct: { trubuddy: -5 } }), /maxCppByProduct/);
});

// ---------------------------------------------------------------------------------------------
// Ads past day 9: judged on their 10-day window
// ---------------------------------------------------------------------------------------------

const BM = { firstPurchaseLimit: { value: 700, sampleSize: 3 } };

test("past day 9, with purchases: Pause when the 10-day CPP is above the product threshold (no margin)", () => {
  assert.equal(judgeWindow({ spend: 2800, purchases: 10 }, BM, 280).verdict, VERDICT.KEEP); // exactly 280
  const over = judgeWindow({ spend: 2810, purchases: 10 }, BM, 280);
  assert.equal(over.verdict, VERDICT.PAUSE);
  assert.equal(over.reason, REASON.WINDOW_CPP_ABOVE_THRESHOLD);
  assert.deepEqual(over.benchmark, { kind: BENCHMARK_KIND.WINDOW_THRESHOLD, threshold: 280 });
  assert.equal(over.cpp, 281);
  assert.equal(judgeWindow({ spend: 2000, purchases: 10 }, BM, 280).reason, REASON.WITHIN_WINDOW_THRESHOLD);
});

test("past day 9, no purchase in the window: the first-purchase limit applies", () => {
  assert.equal(judgeWindow({ spend: 700, purchases: 0 }, BM, 280).verdict, VERDICT.KEEP);
  const r = judgeWindow({ spend: 701, purchases: 0 }, BM, 280);
  assert.equal(r.verdict, VERDICT.PAUSE);
  assert.equal(r.reason, REASON.SPEND_WITHOUT_PURCHASE);
  assert.equal(r.cpp, null);
});

test("past day 9 with nothing to compare against is Keep / no_benchmark", () => {
  assert.equal(judgeWindow({ spend: 9999, purchases: 1 }, BM, null).reason, REASON.NO_BENCHMARK);
  assert.equal(judgeWindow({ spend: 9999, purchases: 0 }, null, 280).reason, REASON.NO_BENCHMARK);
  assert.equal(judgeWindow({ spend: 9999, purchases: 0 }, null, 280).verdict, VERDICT.KEEP);
});

// ---------------------------------------------------------------------------------------------
// Adset roll-up
// ---------------------------------------------------------------------------------------------

test("an adset is Pause if at least one running ad is Pause, Keep only if they are all Keep", () => {
  const keep = { verdict: VERDICT.KEEP, status: "ACTIVE" };
  const pause = { verdict: VERDICT.PAUSE, status: "ACTIVE" };
  assert.deepEqual(rollUpAdset([keep, keep, keep]), { verdict: VERDICT.KEEP, counted: 3, pauseIndexes: [], ignoredPaused: 0 });
  assert.deepEqual(rollUpAdset([keep, pause, keep]), { verdict: VERDICT.PAUSE, counted: 3, pauseIndexes: [1], ignoredPaused: 0 });
});

test("ads already paused in Meta, and ads with no verdict, don't count", () => {
  const r = rollUpAdset([
    { verdict: VERDICT.KEEP, status: "ACTIVE" },
    { verdict: VERDICT.PAUSE, status: "PAUSED" },
    { verdict: null, status: "ACTIVE" },
    { verdict: VERDICT.KEEP, status: "WITH_ISSUES" },
  ]);
  assert.deepEqual(r, { verdict: VERDICT.KEEP, counted: 2, pauseIndexes: [], ignoredPaused: 1 });
  assert.equal(rollUpAdset([{ verdict: VERDICT.PAUSE, status: "ADSET_PAUSED" }]).verdict, null);
  assert.equal(rollUpAdset([]).verdict, null);
});

test("running means not paused, deleted or archived", () => {
  for (const s of ["ACTIVE", "WITH_ISSUES", "IN_PROCESS", null, undefined]) assert.equal(isRunning(s), true, String(s));
  for (const s of ["PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "DELETED", "ARCHIVED"]) assert.equal(isRunning(s), false, s);
});

// ---------------------------------------------------------------------------------------------
// Adset first purchase vs the slowest successful ad
// ---------------------------------------------------------------------------------------------

test("the day limit is the day the slowest successful ad made its first purchase", () => {
  const onDay = (id, n) => ad(id, "gulu", dailyFromCumulative(Array.from({ length: 11 }, (_, i) => [100 * (i + 1), i + 1 >= n ? 1 : 0])));
  const b = buildBenchmarks([onDay("A", 1), onDay("B", 3), onDay("C", 2)]).products.gulu;
  assert.deepEqual(b.firstPurchaseDayLimit, { value: 3, sampleSize: 3 });
  assert.equal(firstPurchaseDay(alignFromFirstSpend(onDay("D", 4).daily), 10), 4);
  assert.equal(firstPurchaseDay(alignFromFirstSpend(onDay("E", 11).daily), 10), null, "only days 1–10 are read");
});

test("the day limit follows the threshold, and is unknown when a counted ad had no purchase by day 10", () => {
  // CHEAP and EDGE buy on day 1; NOBUY first buys on day 11
  const filtered = buildBenchmarks([CHEAP, EDGE, DEAR, NOBUY], { maxCppByProduct: { trubuddy: 280 } }).products.trubuddy;
  assert.deepEqual(filtered.firstPurchaseDayLimit, { value: 1, sampleSize: 2 });
  // with no threshold NOBUY counts, and its first purchase is past the data: leave the limit out
  const open = buildBenchmarks([CHEAP, NOBUY]).products.trubuddy;
  assert.deepEqual(open.firstPurchaseDayLimit, { value: null, sampleSize: 2 });
  assert.deepEqual(buildBenchmarks([]).products.gulu.firstPurchaseDayLimit, { value: null, sampleSize: 0 });
});

const SLOWEST_3 = { firstPurchaseDayLimit: { value: 3, sampleSize: 9 } };
const row = (date, spend, purchases = 0) => ({ date, spend, purchases });

test("adset first purchase: day 1 is the first day any of its ads spent, and every ad's purchases count", () => {
  const ads = [
    { daily: [row("2026-09-01", 0), row("2026-09-02", 300), row("2026-09-03", 250), row("2026-09-04", 100), row("2026-09-05", 90)] },
    { daily: [row("2026-09-01", 0), row("2026-09-02", 100), row("2026-09-03", 60), row("2026-09-04", 40), row("2026-09-05", 20, 1)] },
  ];
  assert.deepEqual(adsetFirstPurchase(ads, SLOWEST_3), {
    verdict: VERDICT.PAUSE,
    reason: REASON.ADSET_FIRST_PURCHASE_TOO_SLOW,
    limit: 3,
    sampleSize: 9,
    firstSpendDate: "2026-09-02",
    ageDays: 4,
    firstPurchaseDate: "2026-09-05",
    firstPurchaseDay: 4,
  });
});

test("a first purchase on the slowest ad's day is in time", () => {
  const ads = [{ daily: [row("2026-09-02", 500), row("2026-09-03", 300), row("2026-09-04", 900, 2), row("2026-09-05", 900)] }];
  const r = adsetFirstPurchase(ads, SLOWEST_3);
  assert.equal(r.firstPurchaseDay, 3);
  assert.equal(r.verdict, VERDICT.KEEP);
  assert.equal(r.reason, REASON.ADSET_FIRST_PURCHASE_IN_TIME);
});

test("with no purchase yet, the adset is Pause once it has run more days than the slowest ad took", () => {
  const ads = [{ daily: [row("2026-09-02", 400), row("2026-09-03", 450)] }, { daily: [row("2026-09-03", 0)] }];
  const young = adsetFirstPurchase(ads, SLOWEST_3);
  assert.equal(young.ageDays, 2);
  assert.equal(young.verdict, VERDICT.KEEP, "day 2 of 3: still has time");
  assert.equal(adsetFirstPurchase(ads, SLOWEST_3, { through: "2026-09-04" }).verdict, VERDICT.KEEP, "day 3: on the line");
  // days without delivery at the end still count as waiting
  const late = adsetFirstPurchase(ads, SLOWEST_3, { through: "2026-09-05" });
  assert.equal(late.ageDays, 4);
  assert.equal(late.firstPurchaseDay, null);
  assert.equal(late.verdict, VERDICT.PAUSE);
  assert.equal(late.reason, REASON.ADSET_FIRST_PURCHASE_TOO_SLOW);
});

test("no limit is Keep / no_benchmark, and an adset that never spent has no verdict", () => {
  const r = adsetFirstPurchase([{ daily: [row("2026-09-02", 5000)] }], null, { through: "2026-09-20" });
  assert.equal(r.verdict, VERDICT.KEEP);
  assert.equal(r.reason, REASON.NO_BENCHMARK);
  assert.equal(adsetFirstPurchase([{ daily: [row("2026-09-02", 0)] }], SLOWEST_3).verdict, null);
  assert.equal(adsetFirstPurchase([], SLOWEST_3).firstSpendDate, null);
});
