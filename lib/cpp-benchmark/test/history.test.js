import { test } from "node:test";
import assert from "node:assert/strict";
import { alignFromFirstSpend, classifyProduct, isSuccessful, resolveConfig, InputError } from "../src/index.js";
import { flatSpend } from "./fixtures.js";

const cfg = resolveConfig();

test("product comes from the campaign name, one keyword per product", () => {
  const cases = [
    ["10Sept-trubuddy-page-demographics-campaign", "trubuddy"],
    ["21august-mpedia-demographics-campaign", "mpedia"],
    ["3July-gulu-demographics-campaign", "gulu"],
    ["25August-period-educator-certificate-campaign", "educator program"],
    ["12Sept-adi-anku-demographics-campaign", "adi anku"],
    ["Adi Anku test", "adi anku"],
    ["adi_anku", "adi anku"],
    ["TRUBUDDY retargeting", "trubuddy"],
  ];
  for (const [name, product] of cases) assert.equal(classifyProduct(name, cfg), product, name);
});

test("a campaign matching no product, or several, is unclassified", () => {
  assert.equal(classifyProduct("brand-awareness-campaign", cfg), null);
  assert.equal(classifyProduct("trubuddy-x-mpedia-combo", cfg), null);
  assert.equal(classifyProduct(undefined, cfg), null);
});

test("day 1 is the first day with spend; leading zero days are dropped", () => {
  const days = alignFromFirstSpend([
    { date: "2026-09-01", spend: 0, purchases: 0 },
    { date: "2026-09-02", spend: 0, purchases: 0 },
    { date: "2026-09-03", spend: 50, purchases: 0 },
    { date: "2026-09-04", spend: 70.25, purchases: 1 },
  ]);
  assert.deepEqual(days, [
    { day: 1, date: "2026-09-03", spend: 50, purchases: 0, cumSpend: 50, cumPurchases: 0 },
    { day: 2, date: "2026-09-04", spend: 70.25, purchases: 1, cumSpend: 120.25, cumPurchases: 1 },
  ]);
});

test("missing dates count as days with no delivery, and rows may come in any order", () => {
  const days = alignFromFirstSpend([
    { date: "2026-09-05", spend: 30, purchases: 1 },
    { date: "2026-09-01", spend: 10, purchases: 0 },
  ]);
  assert.deepEqual(days.map((d) => [d.day, d.date, d.spend, d.cumSpend, d.cumPurchases]), [
    [1, "2026-09-01", 10, 10, 0],
    [2, "2026-09-02", 0, 10, 0],
    [3, "2026-09-03", 0, 10, 0],
    [4, "2026-09-04", 0, 10, 0],
    [5, "2026-09-05", 30, 40, 1],
  ]);
});

test("`through` extends an ad's life to the end of the data window", () => {
  const days = alignFromFirstSpend([{ date: "2026-09-01", spend: 10, purchases: 0 }], { through: "2026-09-04" });
  assert.equal(days.length, 4);
  assert.equal(days[3].cumSpend, 10);
});

test("an ad that never spent has no history", () => {
  assert.equal(alignFromFirstSpend([{ date: "2026-09-01", spend: 0, purchases: 0 }]), null);
  assert.equal(alignFromFirstSpend([]), null);
});

test("bad rows are rejected rather than guessed at", () => {
  assert.throws(() => alignFromFirstSpend([{ date: "2026-02-30", spend: 1, purchases: 0 }]), InputError);
  assert.throws(() => alignFromFirstSpend([{ date: "2026-09-01", spend: -1, purchases: 0 }]), InputError);
  assert.throws(
    () => alignFromFirstSpend([{ date: "2026-09-01", spend: 1, purchases: 0 }, { date: "2026-09-01", spend: 2, purchases: 0 }]),
    /two rows for 2026-09-01/
  );
  assert.throws(() => alignFromFirstSpend("nope"), InputError);
});

test("successful = spent on day 11 or later", () => {
  assert.equal(isSuccessful(alignFromFirstSpend(flatSpend(11)), cfg), true);
  assert.equal(isSuccessful(alignFromFirstSpend(flatSpend(10)), cfg), false);
  // paused on day 11, back on day 12: still ran past day 10
  const gap = [...flatSpend(10), { date: "2026-08-12", spend: 40, purchases: 0 }];
  assert.equal(isSuccessful(alignFromFirstSpend(gap), cfg), true);
  // a trailing zero row on day 11 doesn't count
  const zeroTail = [...flatSpend(10), { date: "2026-08-11", spend: 0, purchases: 0 }];
  assert.equal(isSuccessful(alignFromFirstSpend(zeroTail), cfg), false);
});
