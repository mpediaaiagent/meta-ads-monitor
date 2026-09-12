import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DAY_THRESHOLDS,
  adsetProductThreshold,
  effectiveCpp,
  judgeProductThreshold,
  resolveConfig,
  thresholdForDay,
  REASON,
  VERDICT,
} from "../src/index.js";
import { dailyFromCumulative } from "./fixtures.js";

const CFG = resolveConfig({ productDayThresholds: DEFAULT_DAY_THRESHOLDS });
const TB = DEFAULT_DAY_THRESHOLDS.trubuddy;
const GU = DEFAULT_DAY_THRESHOLDS.gulu;
const live = (daily) => ({ daily });

test("spend counts as the CPP when nothing has been bought", () => {
  assert.equal(effectiveCpp(900, 3), 300);
  assert.equal(effectiveCpp(900, 0), 900, "no purchases: the spend itself is the CPP");
  assert.equal(effectiveCpp(0, 0), null, "nothing spent either: nothing to say");
  assert.equal(effectiveCpp(1000, 3), 333.33);
});

test("the checkpoint in force is the latest one at or before the day", () => {
  assert.equal(thresholdForDay(TB, 1), null, "below the first checkpoint there is no threshold");
  assert.equal(thresholdForDay(TB, 2).maxCpp, 700);
  assert.equal(thresholdForDay(TB, 3).maxCpp, 527);
  assert.equal(thresholdForDay(TB, 4).maxCpp, 527, "day 4 holds the day-3 number");
  assert.equal(thresholdForDay(TB, 5).maxCpp, 370);
  assert.equal(thresholdForDay(TB, 9).maxCpp, 370, "days 6-9 hold the day-5 number");
  assert.equal(thresholdForDay(TB, 10).maxCpp, 280);
  assert.equal(thresholdForDay(TB, 40).maxCpp, 280, "and it holds from then on");
  assert.equal(thresholdForDay(null, 5), null);
});

test("the trubuddy schedule is the one that was specified", () => {
  assert.deepEqual(TB.map((s) => [s.day, s.maxCpp]), [[2, 700], [3, 527], [5, 370], [10, 280]]);
});

test("the mpedia and gulu schedules are the one that was specified, day 2 being a purchase count", () => {
  for (const s of [DEFAULT_DAY_THRESHOLDS.mpedia, GU]) {
    assert.deepEqual(s.map((x) => [x.day, x.maxCpp ?? null, x.minPurchases ?? null]),
      [[2, null, 1], [3, 470, null], [5, 330, null], [10, 250, null]]);
  }
});

test("adi anku and educator program have no schedule, so nothing can rescue them", () => {
  assert.equal(DEFAULT_DAY_THRESHOLDS["adi anku"], undefined);
  assert.equal(DEFAULT_DAY_THRESHOLDS["educator program"], undefined);
  const r = judgeProductThreshold({ day: 5, cumSpend: 100, cumPurchases: 5 }, null);
  assert.equal(r.checked, false);
  assert.equal(r.notChecked, "no_schedule");
});

test("a CPP checkpoint: at or under the number is within, above it is not", () => {
  const at = (cpp) => judgeProductThreshold({ day: 3, cumSpend: cpp * 2, cumPurchases: 2 }, TB);
  assert.equal(at(500).verdict, VERDICT.KEEP);
  assert.equal(at(527).verdict, VERDICT.KEEP, "exactly on the threshold is within it");
  assert.equal(at(528).verdict, VERDICT.PAUSE);
  assert.equal(at(500).reason, REASON.WITHIN_PRODUCT_THRESHOLD);
  assert.equal(at(528).reason, REASON.ABOVE_PRODUCT_THRESHOLD);
  assert.equal(at(500).checkpointDay, 3);
  assert.equal(at(500).kind, "cpp");
});

test("with no purchase the spend is measured against the CPP threshold", () => {
  const r = judgeProductThreshold({ day: 5, cumSpend: 400, cumPurchases: 0 }, TB);
  assert.equal(r.cpp, 400, "spend became the CPP");
  assert.equal(r.limit, 370);
  assert.equal(r.verdict, VERDICT.PAUSE);

  const ok = judgeProductThreshold({ day: 5, cumSpend: 300, cumPurchases: 0 }, TB);
  assert.equal(ok.verdict, VERDICT.KEEP);
});

test("a purchase-count checkpoint asks for purchases, not a CPP", () => {
  const none = judgeProductThreshold({ day: 2, cumSpend: 50, cumPurchases: 0 }, GU);
  assert.equal(none.kind, "purchases");
  assert.equal(none.limit, 1);
  assert.equal(none.verdict, VERDICT.PAUSE);
  assert.equal(judgeProductThreshold({ day: 2, cumSpend: 5000, cumPurchases: 1 }, GU).verdict, VERDICT.KEEP,
    "one purchase clears it however much was spent");
});

test("an adset is immune on days 1 and 2, so the schedule can't be read then", () => {
  for (const days of [1, 2]) {
    const daily = dailyFromCumulative(Array.from({ length: days }, () => [9999, 0]));
    const r = adsetProductThreshold([live(daily)], TB, CFG);
    assert.equal(r.checked, false, `day ${days} must not be judged`);
    assert.equal(r.reason, REASON.IMMUNE_EARLY_DAYS);
  }
});

test("from day 3 the adset is measured against its product's schedule", () => {
  // ₹1,200 over 3 days with 3 purchases = CPP 400, under trubuddy's day-3 threshold of 527
  const ok = adsetProductThreshold([live(dailyFromCumulative([[400, 1], [800, 2], [1200, 3]]))], TB, CFG);
  assert.equal(ok.checked, true);
  assert.equal(ok.day, 3);
  assert.equal(ok.cpp, 400);
  assert.equal(ok.verdict, VERDICT.KEEP);

  // same spend, one purchase = CPP 1200, over it
  const bad = adsetProductThreshold([live(dailyFromCumulative([[400, 0], [800, 0], [1200, 1]]))], TB, CFG);
  assert.equal(bad.cpp, 1200);
  assert.equal(bad.verdict, VERDICT.PAUSE);
});

test("every ad in the adset is summed before the threshold is applied", () => {
  const one = dailyFromCumulative([[200, 1], [400, 1], [600, 1]]);
  const r = adsetProductThreshold([live(one), live(one)], TB, CFG);
  assert.equal(r.cumSpend, 1200);
  assert.equal(r.cumPurchases, 2);
  assert.equal(r.cpp, 600, "₹1,200 ÷ 2");
  assert.equal(r.verdict, VERDICT.PAUSE, "over the day-3 threshold of 527");
});

test("the schedule is validated, so a typo can't quietly disable a threshold", () => {
  assert.throws(() => resolveConfig({ productDayThresholds: { trubuddy: [{ day: 3 }] } }), RangeError, "needs one of maxCpp/minPurchases");
  assert.throws(() => resolveConfig({ productDayThresholds: { trubuddy: [{ day: 3, maxCpp: 5, minPurchases: 1 }] } }), RangeError, "not both");
  assert.throws(() => resolveConfig({ productDayThresholds: { trubuddy: [{ day: 5, maxCpp: 1 }, { day: 3, maxCpp: 2 }] } }), RangeError, "must ascend");
  assert.throws(() => resolveConfig({ productDayThresholds: { trubuddy: [{ day: 0, maxCpp: 1 }] } }), RangeError, "day >= 1");
  assert.throws(() => resolveConfig({ productDayThresholds: { trubuddy: [{ day: 3, maxCpp: -1 }] } }), RangeError, "maxCpp > 0");
});
