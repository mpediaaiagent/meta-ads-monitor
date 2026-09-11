import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runBenchmark,
  buildBenchmarkCurves,
  evaluateAds,
  classifyPosition,
  classifyTrajectory,
  decideRemark,
  resolveConfig,
  STATUS,
  POSITION,
  TRAJECTORY,
  CONFIDENCE,
  REMARK,
  URGENCY,
  SCHEMA_VERSION,
} from "../src/index.js";
import { adRows, adWithCpp, MPEDIA_COHORT } from "./fixtures.js";

const cfg = resolveConfig();
const recordsFor = (result, adId) => result.records.filter((r) => r.adId === adId);

// ---------------------------------------------------------------------------------------------
// Minimum data floor
// ---------------------------------------------------------------------------------------------

test("below the floor an ad gets insufficient_data and no verdict of any kind", () => {
  const x = adRows("X", "mpedia", [[149, 0], [150, 0], [400, 1]]);
  const [day1, day2, day3] = recordsFor(runBenchmark([...MPEDIA_COHORT, ...x]), "X");

  assert.equal(day1.status, STATUS.INSUFFICIENT_DATA);
  assert.equal(day1.remark, REMARK.INSUFFICIENT_DATA);
  for (const field of ["position", "trajectory", "trajectoryChange", "confidence", "urgency", "benchmark", "comparedCpp"]) {
    assert.equal(day1[field], null, `${field} must be null below the floor`);
  }

  // ₹150 with no purchase crosses the floor; it's compared as a CPP of at least 150
  assert.equal(day2.status, STATUS.EVALUATED);
  assert.equal(day2.cumCpp, null);
  assert.equal(day2.comparedCpp, 150);
  assert.equal(day2.position, POSITION.INSIDE); // day-2 ceiling is 320
  // day 1 never cleared the floor, so it can't serve as a trajectory baseline
  assert.equal(day2.trajectory, TRAJECTORY.UNKNOWN);
  assert.equal(day2.remark, REMARK.HOLD_WATCH);

  // day 3: 400 against a 300 ceiling (+22% = 366) → outside, with plenty of runway
  assert.equal(day3.position, POSITION.OUTSIDE);
  assert.equal(day3.trajectory, TRAJECTORY.WORSENING); // vs day 2's 150, not day 1's pre-floor 149
  assert.equal(day3.remark, REMARK.WAIT_ONE_MORE_DAY);
});

test("a single purchase crosses the floor on its own, whatever the spend", () => {
  const cheap = adRows("cheap", "mpedia", [[20, 1]]);
  const [day1] = recordsFor(runBenchmark([...MPEDIA_COHORT, ...cheap]), "cheap");
  assert.equal(day1.status, STATUS.EVALUATED);
  assert.equal(day1.cumCpp, 20);
});

test("a great-looking raw CPP below a raised floor is still insufficient_data", () => {
  const cheap = adRows("cheap", "mpedia", [[20, 1]]);
  const options = { floor: { minCumPurchases: 2 } };
  const [day1] = recordsFor(runBenchmark([...MPEDIA_COHORT, ...cheap], options), "cheap");
  assert.equal(day1.status, STATUS.INSUFFICIENT_DATA);
  assert.equal(day1.position, null);
});

// ---------------------------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------------------------

test("position: at/under ceiling is inside, within the margin is near_edge, beyond is outside", () => {
  const point = { ceiling: 280, upperBound: 280 * 1.1 };
  assert.equal(classifyPosition(250, point), POSITION.INSIDE);
  assert.equal(classifyPosition(280, point), POSITION.INSIDE);
  assert.equal(classifyPosition(280.01, point), POSITION.NEAR_EDGE);
  assert.equal(classifyPosition(308, point), POSITION.NEAR_EDGE); // exactly ceiling + 10%
  assert.equal(classifyPosition(308.01, point), POSITION.OUTSIDE);
});

// ---------------------------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------------------------

test("trajectory: lower CPP is improving, and ±2.5% counts as flat", () => {
  const t = (from, to, tol = 0.025) => classifyTrajectory(from, to, tol).trajectory;
  assert.equal(t(100, 97.5), TRAJECTORY.FLAT);
  assert.equal(t(100, 102.5), TRAJECTORY.FLAT);
  assert.equal(t(100, 100), TRAJECTORY.FLAT);
  assert.equal(t(100, 97.4), TRAJECTORY.IMPROVING);
  assert.equal(t(100, 102.6), TRAJECTORY.WORSENING);
  assert.equal(t(100, 104, 0.05), TRAJECTORY.FLAT, "tolerance is configurable");
  assert.ok(Math.abs(classifyTrajectory(200, 190, 0.025).change - -0.05) < 1e-12);
});

test("trajectory compares against the day lookbackDays back, not yesterday", () => {
  // day 1: 300 · day 2: 350 (a spike) · day 3: 290 — 3.3% under day 1
  const y = adRows("Y", "mpedia", [[300, 1], [700, 2], [870, 3]]);
  const day3 = (options) => recordsFor(runBenchmark([...MPEDIA_COHORT, ...y], options), "Y")[2];
  assert.equal(day3().trajectory, TRAJECTORY.IMPROVING);
  assert.equal(day3({ trajectory: { flatTolerance: 0.05 } }).trajectory, TRAJECTORY.FLAT);
  assert.equal(day3({ trajectory: { lookbackDays: 1 } }).trajectory, TRAJECTORY.IMPROVING); // 350 → 290
});

// ---------------------------------------------------------------------------------------------
// Remark matrix
// ---------------------------------------------------------------------------------------------

test("remark matrix matches the spec table", () => {
  const high = 7; // runway above lowMaxDays (3)
  const low = 2;
  const cases = [
    [POSITION.INSIDE, TRAJECTORY.IMPROVING, high, REMARK.SCALE_CANDIDATE],
    [POSITION.INSIDE, TRAJECTORY.FLAT, high, REMARK.HOLD_WATCH],
    [POSITION.INSIDE, TRAJECTORY.WORSENING, high, REMARK.HOLD_WATCH],
    [POSITION.NEAR_EDGE, TRAJECTORY.IMPROVING, high, REMARK.HOLD],
    [POSITION.NEAR_EDGE, TRAJECTORY.FLAT, high, REMARK.REDUCE_SPEND],
    [POSITION.NEAR_EDGE, TRAJECTORY.WORSENING, low, REMARK.REDUCE_SPEND],
    [POSITION.OUTSIDE, TRAJECTORY.IMPROVING, high, REMARK.WAIT_ONE_MORE_DAY],
    [POSITION.OUTSIDE, TRAJECTORY.WORSENING, high, REMARK.WAIT_ONE_MORE_DAY],
    [POSITION.OUTSIDE, TRAJECTORY.IMPROVING, low, REMARK.PAUSE_CANDIDATE],
    [POSITION.OUTSIDE, TRAJECTORY.FLAT, 3, REMARK.PAUSE_CANDIDATE], // lowMaxDays is inclusive
    [POSITION.OUTSIDE, TRAJECTORY.FLAT, 4, REMARK.WAIT_ONE_MORE_DAY],
  ];
  for (const [position, trajectory, runwayDays, expected] of cases) {
    const got = decideRemark({ confidence: CONFIDENCE.OK, position, trajectory, runwayDays }, cfg);
    assert.equal(got, expected, `${position} × ${trajectory} × runway ${runwayDays}`);
  }
});

test("low confidence forces hold_monitor regardless of the other signals", () => {
  for (const position of [POSITION.INSIDE, POSITION.NEAR_EDGE, POSITION.OUTSIDE, null]) {
    for (const trajectory of Object.values(TRAJECTORY)) {
      for (const runwayDays of [0, 9]) {
        assert.equal(decideRemark({ confidence: CONFIDENCE.LOW, position, trajectory, runwayDays }, cfg), REMARK.HOLD_MONITOR);
      }
    }
  }
});

test("an unknown trajectory is read as flat by default, and that is configurable", () => {
  const signal = { confidence: CONFIDENCE.OK, position: POSITION.INSIDE, trajectory: TRAJECTORY.UNKNOWN, runwayDays: 9 };
  assert.equal(decideRemark(signal, cfg), REMARK.HOLD_WATCH);
  const optimistic = resolveConfig({ trajectory: { treatUnknownAs: TRAJECTORY.IMPROVING } });
  assert.equal(decideRemark(signal, optimistic), REMARK.SCALE_CANDIDATE);
});

// ---------------------------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------------------------

test("a ten-day path walks through the whole table", () => {
  // Cumulative CPP by day, against the mpedia ceilings [350 320 300 290 280 275 275 275 275 275]:
  //  day 1–5 at or under the ceiling and falling · day 6–8 into the 10% margin and rising ·
  //  day 9 through it · day 10 back into the margin and falling.
  const z = adWithCpp("Z", "mpedia", [340, 315, 295, 285, 280, 285, 290, 300, 320, 290]);
  const records = recordsFor(runBenchmark([...MPEDIA_COHORT, ...z]), "Z");

  assert.deepEqual(records.map((r) => r.position), [
    "inside", "inside", "inside", "inside", "inside", "near_edge", "near_edge", "near_edge", "outside", "near_edge",
  ]);
  assert.deepEqual(records.map((r) => r.trajectory), [
    "unknown", "improving", "improving", "improving", "improving", "flat", "worsening", "worsening", "worsening", "improving",
  ]);
  assert.deepEqual(records.map((r) => r.remark), [
    REMARK.HOLD_WATCH,
    REMARK.SCALE_CANDIDATE,
    REMARK.SCALE_CANDIDATE,
    REMARK.SCALE_CANDIDATE,
    REMARK.SCALE_CANDIDATE,
    REMARK.REDUCE_SPEND,
    REMARK.REDUCE_SPEND,
    REMARK.REDUCE_SPEND,
    REMARK.PAUSE_CANDIDATE,
    REMARK.HOLD,
  ]);
  // reduce_spend gets more urgent as runway shrinks (runway 4, 3, 2)
  assert.deepEqual(records.map((r) => r.urgency), [
    null, null, null, null, null, URGENCY.MEDIUM, URGENCY.MEDIUM, URGENCY.HIGH, null, null,
  ]);
  assert.deepEqual(records.map((r) => r.runwayDays), [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test("outside waits while runway is high and becomes pause_candidate once it is low", () => {
  const w = adWithCpp("W", "mpedia", Array(10).fill(1000));
  const remarks = (options) => recordsFor(runBenchmark([...MPEDIA_COHORT, ...w], options), "W").map((r) => r.remark);
  const wait = REMARK.WAIT_ONE_MORE_DAY;
  const pause = REMARK.PAUSE_CANDIDATE;
  assert.deepEqual(remarks(), [wait, wait, wait, wait, wait, wait, pause, pause, pause, pause]);
  assert.deepEqual(remarks({ runway: { lowMaxDays: 5 } }), [wait, wait, wait, wait, pause, pause, pause, pause, pause, pause]);
});

test("an ad in a low-confidence product gets hold_monitor every day, even far outside", () => {
  const e = adRows("E", "educator program", Array.from({ length: 10 }, (_, i) => [5000 * (i + 1), 1]));
  const records = recordsFor(runBenchmark([...MPEDIA_COHORT, ...e]), "E");
  for (const r of records) {
    assert.equal(r.status, STATUS.EVALUATED);
    assert.equal(r.confidence, CONFIDENCE.LOW);
    assert.equal(r.position, null);
    assert.equal(r.benchmark.ceiling, null);
    assert.equal(r.remark, REMARK.HOLD_MONITOR);
  }
  // trajectory is the ad's own history, so it is still reported
  assert.equal(records[9].trajectory, TRAJECTORY.WORSENING);
});

test("days past the horizon are marked beyond_benchmark_window, not judged", () => {
  const long = adWithCpp("L", "mpedia", Array(12).fill(250));
  const records = recordsFor(runBenchmark([...MPEDIA_COHORT, ...long]), "L");
  assert.equal(records.length, 12);
  assert.equal(records[9].status, STATUS.EVALUATED);
  for (const r of records.slice(10)) {
    assert.equal(r.status, STATUS.BEYOND_BENCHMARK_WINDOW);
    assert.equal(r.remark, REMARK.BEYOND_BENCHMARK_WINDOW);
    assert.equal(r.runwayDays, 0);
    assert.equal(r.position, null);
    assert.equal(r.trajectory, null);
  }
});

test("evaluateAds scores new rows against previously built curves", () => {
  const curves = buildBenchmarkCurves(MPEDIA_COHORT);
  const z = adWithCpp("Z", "mpedia", [340, 315]);
  const records = evaluateAds(z, curves);
  assert.deepEqual(records.map((r) => r.remark), [REMARK.HOLD_WATCH, REMARK.SCALE_CANDIDATE]);
  assert.throws(() => evaluateAds(z, curves, { horizonDays: 7 }), /10-day horizon/);
  assert.throws(() => evaluateAds(z, { products: {} }), /buildBenchmarkCurves/);
});

// ---------------------------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------------------------

test("every record has the same named fields, in the same order", () => {
  const x = adRows("X", "mpedia", [[100, 0], [300, 1]]);
  const { records } = runBenchmark([...MPEDIA_COHORT, ...x]);
  const expected = [
    "adId", "product", "date", "ageDays", "runwayDays", "cumSpend", "cumPurchases", "cumCpp", "comparedCpp",
    "status", "confidence", "position", "trajectory", "trajectoryChange", "remark", "urgency", "benchmark",
  ];
  for (const r of records) assert.deepEqual(Object.keys(r), expected);
  const evaluated = records.find((r) => r.status === STATUS.EVALUATED);
  assert.deepEqual(Object.keys(evaluated.benchmark), ["ceiling", "margin", "upperBound", "sampleSize"]);
});

test("the whole result is plain JSON: survives a round trip unchanged", () => {
  const z = adWithCpp("Z", "mpedia", [340, 315, 295, 285, 280, 285, 290, 300, 320, 290]);
  const edu = adRows("E", "educator program", [[100, 0], [800, 1]]);
  const result = runBenchmark([...MPEDIA_COHORT, ...z, ...edu]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.config.ceilingStatistic, "max");
  assert.equal(result.records.length, MPEDIA_COHORT.length + z.length + edu.length);
});

test("records come out grouped by ad, day 1 first, whatever the input order", () => {
  const z = adWithCpp("Z", "mpedia", [340, 315, 295]);
  const shuffled = [...MPEDIA_COHORT, ...z].reverse();
  const { records } = runBenchmark(shuffled);
  const zRecords = recordsFor({ records }, "Z");
  assert.deepEqual(zRecords.map((r) => r.ageDays), [1, 2, 3]);
  assert.deepEqual([...new Set(records.map((r) => r.adId))], ["A", "B", "C", "Z"]);
});
