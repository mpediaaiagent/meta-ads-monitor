import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchmarks, judgeWindow, rollUpAdset, isRunning, cppOnDay, alignFromFirstSpend, resolveConfig, VERDICT, REASON, BENCHMARK_KIND } from "../src/index.js";
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
