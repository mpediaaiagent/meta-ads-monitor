import { test } from "node:test";
import assert from "node:assert/strict";
import { runBenchmark, resolveConfig, describeConfig, DEFAULT_CONFIG, InputError, STATISTICS } from "../src/index.js";
import { adRows, adWithCpp, MPEDIA_COHORT } from "./fixtures.js";

/** Runs the input and returns the InputError's issue list (fails the test if nothing threw). */
function issuesFor(rows, options) {
  try {
    runBenchmark(rows, options);
  } catch (err) {
    assert.ok(err instanceof InputError, `expected InputError, got ${err}`);
    return err.issues;
  }
  assert.fail("expected the input to be rejected");
}

// ---------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------

test("product names are matched case- and space-insensitively", () => {
  const rows = adWithCpp("aa", "  Adi   Anku ", [300, 290]);
  const { records } = runBenchmark(rows);
  assert.equal(records[0].product, "adi anku");
});

test("numeric ad ids are accepted and reported as strings", () => {
  const { records } = runBenchmark(adWithCpp(120211, "gulu", [300]));
  assert.equal(records[0].adId, "120211");
});

test("a product without a day-10 goal is rejected, not silently skipped", () => {
  const issues = issuesFor(adWithCpp("u", "unknown brand", [300]));
  assert.match(issues[0], /product "unknown brand" has no day-10 goal/);
});

test("a history that starts after day 1 is rejected — a trailing window is not lifetime history", () => {
  const trailing = adWithCpp("t", "mpedia", [300, 290, 280]).map((r) => ({ ...r, ageDays: r.ageDays + 6 }));
  const issues = issuesFor(trailing);
  assert.match(issues[0], /starts at day 7, not day 1/);
});

test("missing, repeated and misdated days are rejected", () => {
  const rows = adWithCpp("g", "mpedia", [300, 290, 280, 270]);
  assert.match(issuesFor(rows.filter((r) => r.ageDays !== 3))[0], /day 3 is missing/);
  assert.match(issuesFor([...rows, rows[1]])[0], /day 2 appears more than once/);
  const misdated = rows.map((r) => (r.ageDays === 4 ? { ...r, date: "2026-08-09" } : r));
  assert.match(issuesFor(misdated)[0], /day 4 is dated 2026-08-09, expected 2026-08-04/);
});

test("malformed rows are rejected with every problem listed", () => {
  const good = adWithCpp("ok", "mpedia", [300])[0];
  const issues = issuesFor([
    { ...good, adId: "" },
    { ...good, adId: "neg", spend: -5 },
    { ...good, adId: "date", date: "2026-02-30" },
    { ...good, adId: "age", ageDays: 0 },
    { ...good, adId: "cpp", cumCpp: 999 },
    null,
  ]);
  assert.equal(issues.length, 6);
  assert.match(issues[0], /adId is missing/);
  assert.match(issues[1], /spend must be a number >= 0/);
  assert.match(issues[2], /not a YYYY-MM-DD date/);
  assert.match(issues[3], /ageDays must be an integer >= 1/);
  assert.match(issues[4], /cumCpp 999 disagrees/);
  assert.match(issues[5], /not an object/);
});

test("an ad whose product changes mid-history is rejected", () => {
  const rows = adWithCpp("flip", "mpedia", [300, 290]);
  rows[1] = { ...rows[1], product: "gulu" };
  assert.match(issuesFor(rows)[0], /earlier rows for this ad say "mpedia"/);
});

test("a zero-purchase cumCpp may be encoded any way (null, 0, Infinity)", () => {
  for (const cumCpp of [null, 0, Infinity, undefined]) {
    const rows = adRows("z", "mpedia", [[200, 0]]).map((r) => ({ ...r, cumCpp }));
    assert.equal(runBenchmark(rows).records[0].comparedCpp, 200);
  }
});

test("non-array input is rejected", () => {
  assert.throws(() => runBenchmark({ rows: [] }), InputError);
});

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

test("defaults hold the agreed goals and starting values", () => {
  const c = resolveConfig();
  assert.deepEqual(c.goals, {
    "adi anku": { maxCpp: 280, minPurchases: 17 },
    "educator program": { maxCpp: 700, minPurchases: 1 },
    gulu: { maxCpp: 280, minPurchases: 17 },
    mpedia: { maxCpp: 280, minPurchases: 17 },
    trubuddy: { maxCpp: 280, minPurchases: 17 },
  });
  assert.equal(c.ceilingStatistic, STATISTICS.max);
  assert.equal(c.minCohortSize, 3);
  assert.equal(c.margin.standard, 0.1);
  assert.equal(c.floor.minCumSpend, 150);
  assert.equal(c.floor.minCumPurchases, 1);
  assert.equal(c.trajectory.flatTolerance, 0.025);
});

test("overrides merge key by key within a section", () => {
  const c = resolveConfig({ margin: { earlyStart: 0.5 }, runway: { reduceSpendUrgency: { highMaxDays: 1 } } });
  assert.equal(c.margin.earlyStart, 0.5);
  assert.equal(c.margin.standard, DEFAULT_CONFIG.margin.standard);
  assert.equal(c.runway.reduceSpendUrgency.highMaxDays, 1);
  assert.equal(c.runway.reduceSpendUrgency.mediumMaxDays, 5);
  assert.equal(c.runway.lowMaxDays, 3);
});

test("goals are replaced wholesale, and keys are normalised", () => {
  const c = resolveConfig({ goals: { "Adi Anku": { maxCpp: 300, minPurchases: 10 } } });
  assert.deepEqual(Object.keys(c.goals), ["adi anku"]);
  const issues = issuesFor(adWithCpp("m", "mpedia", [300]), { goals: c.goals });
  assert.match(issues[0], /product "mpedia" has no day-10 goal/);
});

test("typos and nonsense values in the config are rejected loudly", () => {
  assert.throws(() => resolveConfig({ margins: {} }), /Unknown config key\(s\): margins/);
  assert.throws(() => resolveConfig({ floor: { minSpend: 100 } }), /Unknown floor key\(s\): minSpend/);
  assert.throws(() => resolveConfig({ minCohortSize: 0 }), /minCohortSize/);
  assert.throws(() => resolveConfig({ margin: { earlyStart: 0.05 } }), /earlyStart must be a rate >= margin.standard/);
  assert.throws(() => resolveConfig({ trajectory: { treatUnknownAs: "sideways" } }), /treatUnknownAs/);
  assert.throws(() => resolveConfig({ runway: { reduceSpendUrgency: { highMaxDays: 6 } } }), /highMaxDays <= mediumMaxDays/);
  assert.throws(() => resolveConfig({ goals: { mpedia: { maxCpp: 280 } } }), /minPurchases/);
  assert.throws(() => resolveConfig({ goals: { mpedia: { maxCpp: 1, minPurchases: 1 }, MPEDIA: { maxCpp: 1, minPurchases: 1 } } }), /twice/);
  assert.throws(() => resolveConfig({ ceilingStatistic: "max" }), /ceilingStatistic/);
});

test("resolved config is frozen and does not freeze the caller's objects", () => {
  const steps = [0.3, 0.2];
  const c = resolveConfig({ margin: { steps } });
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.margin) && Object.isFrozen(c.margin.steps));
  assert.ok(!Object.isFrozen(steps));
  assert.equal(resolveConfig(c), c, "resolving twice is a no-op");
});

test("describeConfig is plain JSON and names the statistic", () => {
  const d = describeConfig(resolveConfig({ ceilingStatistic: STATISTICS.percentile(80) }));
  assert.equal(d.ceilingStatistic, "p80");
  assert.deepEqual(JSON.parse(JSON.stringify(d)), d);
});

test("the cohort fixture is valid input", () => {
  assert.doesNotThrow(() => runBenchmark(MPEDIA_COHORT));
});
