# cpp-benchmark

A pure calculation layer. Given every ad's day-by-day history, it:

1. builds a **benchmark curve** per product: a CPP ceiling for each of days 1–10, drawn from the ads that went on to hit their product's day-10 goal
2. judges every ad on every day against that curve and returns a **remark** (scale, hold, reduce spend, pause…)

It does no I/O: no D1, no Meta API, no UI. It also isn't wired into the dashboard yet. Wiring it
in is a separate task, and it's blocked on data (see [Blocked on](#blocked-on-lifetime-ad-history)).

```
lib/cpp-benchmark/
├── src/
│   ├── index.js       ← public API: runBenchmark, buildBenchmarkCurves, evaluateAds, enums
│   ├── config.js      ← every tunable number and the product goals — tune here, not in the logic
│   ├── curve.js       ← successful cohort → per-day ceiling + margin
│   ├── evaluate.js    ← floor, position, trajectory, runway → remark
│   ├── metrics.js     ← how cumulative CPP is read (shared by both sides of every comparison)
│   ├── statistics.js  ← swappable ceiling statistics (max, percentile)
│   ├── input.js       ← validates and groups the input rows
│   └── constants.js   ← every output enum, plus SCHEMA_VERSION
└── test/              ← node:test, no dependencies
```

Run the tests with `npm test` from this folder (Node 18+). There's nothing to install.

---

## Usage

```js
import { runBenchmark, STATISTICS } from "./lib/cpp-benchmark/src/index.js";

const { curves, records } = runBenchmark(rows);               // defaults
const tuned = runBenchmark(rows, {
  goals: liveThresholdsFromD1,                                // replaces the default goals wholesale
  ceilingStatistic: STATISTICS.percentile(80),                // instead of max
  margin: { earlyStart: 0.25, taperDays: 4 },                 // merges with the other margin defaults
});
```

To build the curves on one schedule and score ads on another:

```js
const curves = buildBenchmarkCurves(allHistory);   // recompute whenever you like, e.g. daily
const records = evaluateAds(todaysRows, curves);   // pass the same options both times
```

Every call recomputes from scratch and nothing is cached, so refreshing the curve as new ads join
the cohort just means calling it again.

---

## Input: one row per ad per day

| field          | type         | notes |
|----------------|--------------|-------|
| `adId`         | string/number | reported back as a string |
| `product`      | string       | one of the `goals` keys, case/space-insensitive (`"Adi Anku"` = `"adi anku"`) |
| `date`         | `YYYY-MM-DD` | |
| `ageDays`      | integer ≥ 1  | 1 = the ad's first day |
| `spend`        | number ≥ 0   | that day |
| `purchases`    | number ≥ 0   | that day |
| `cumSpend`     | number ≥ 0   | through that day. **Source of truth.** |
| `cumPurchases` | number ≥ 0   | through that day. **Source of truth.** |
| `cumCpp`       | number, optional | only cross-checked against `cumSpend / cumPurchases`. A zero-purchase day may use `null`, `0` or `Infinity` |

Each ad's rows must run **day 1, 2, 3… on consecutive dates**, with no gaps or repeats. Row order
doesn't matter. Bad input throws an `InputError` whose `.issues` lists every problem. Rows are
never silently skipped, because a quietly dropped row is how the adset undercount bug hid (see the
project README).

---

## Output

`runBenchmark` returns:

```js
{
  schemaVersion: 1,
  config:  { … },   // JSON snapshot of the settings used, statistic named e.g. "max" / "p80"
  curves:  { … },   // below
  records: [ … ],   // one DailyRecord per ad per day, grouped by adId, day 1 first
}
```

Everything is plain JSON (no functions, `Infinity` or `NaN`). The shape is fixed: every key is
always present, and fields that don't apply are `null`, never missing.

### DailyRecord — what the dashboard will consume

```js
{
  adId: "120211…",        product: "mpedia",
  date: "2026-09-04",     ageDays: 6,          runwayDays: 4,      // days left until day 10, never negative
  cumSpend: 3420,         cumPurchases: 12,
  cumCpp: 285,            // null before the first purchase
  comparedCpp: 285,       // the value actually compared (cumSpend when 0 purchases); null unless evaluated
  status: "evaluated",    // | "insufficient_data" | "beyond_benchmark_window"
  confidence: "ok",       // | "low" — the benchmark's confidence for this product/day; null unless evaluated
  position: "near_edge",  // | "inside" | "outside"; null unless evaluated with an ok benchmark
  trajectory: "flat",     // | "improving" | "worsening" | "unknown"; null unless evaluated
  trajectoryChange: 0,    // relative change over the lookback: -0.05 = 5% cheaper
  remark: "reduce_spend",
  urgency: "medium",      // reduce_spend only: "low" | "medium" | "high"; null otherwise
  benchmark: { ceiling: 275, margin: 0.1, upperBound: 302.5, sampleSize: 3 },  // null unless evaluated
}
```

### Curves

```js
curves.products["educator program"] = {
  product, goal: { maxCpp: 700, minPurchases: 1 },
  cohortSize: 3, cohortAdIds: ["…"],
  days: [ { day: 1, sampleSize: 3, confidence: "ok", ceiling: 600, margin: 0.3, upperBound: 780 }, … ],
}
```

Every configured product gets a curve, even with zero ads (all days `low`).

---

## The rules

### 1. Benchmark curve (per product, independently)

- **Successful cohort**: ads with at least 10 days of history whose day-10 cumulative CPP is
  `<= goal.maxCpp` **and** whose cumulative purchases are `>= goal.minPurchases`.
- **Ceiling** for day *d* = `ceilingStatistic` over the cohort's day-*d* CPPs. Default `max`;
  `STATISTICS.percentile(75|80)` or any `{ name, compute(values) }` drops in.
- **Margin** on top: tapers linearly from `margin.earlyStart` on day 1 to `margin.standard` on day
  `taperDays + 1`. Defaults: 30% → 26 → 22 → 18 → 14 → 10% from day 6. Set `margin.steps` for
  explicit per-day values instead.
- **Sample gate**: fewer than `minCohortSize` (3) cohort ads on a day → no ceiling, `confidence: "low"`.
- **Educator program is never blended** with the other four. Each product only ever sees its own
  ads, and there's no cross-product fallback. A thin product stays low confidence.

### 2. Minimum data floor

An ad day isn't judged until `cumSpend >= floor.minCumSpend` (₹150) **or**
`cumPurchases >= floor.minCumPurchases` (1). Below that, its status and remark are
`insufficient_data`, with no position, trajectory or confidence, however the raw CPP looks.

### 3. Signals

- **Position**: `comparedCpp` vs that day's curve. `inside` if ≤ ceiling, `near_edge` if ≤
  ceiling × (1 + margin), otherwise `outside`.
- **Trajectory**: today's CPP vs the CPP `trajectory.lookbackDays` (2) days earlier. A change
  within ±`flatTolerance` (2.5%) is `flat`, lower is `improving` and higher is `worsening`. Only
  days that had themselves cleared the floor count as a baseline. If there isn't one, it's
  `unknown`, and the remark step reads that as `treatUnknownAs` (flat).
- **Runway**: `10 − ageDays`. It isn't a classification of its own. It only picks between
  wait and pause, and sets reduce_spend's urgency.

### 4. Remark

| position   | trajectory       | remark |
|------------|------------------|--------|
| inside     | improving        | `scale_candidate` |
| inside     | flat / worsening | `hold_watch` |
| near_edge  | improving        | `hold` |
| near_edge  | flat / worsening | `reduce_spend` + urgency (high ≤ 2 days of runway, medium ≤ 5, else low) |
| outside    | any, runway > 3  | `wait_one_more_day` |
| outside    | any, runway ≤ 3  | `pause_candidate` |
| *low-confidence benchmark* | *anything* | `hold_monitor` (overrides the table) |

---

## Decisions made here that the spec didn't settle

Each one is a single named setting or function, so it's easy to revisit.

1. **CPP before the first purchase** is read as `cumSpend`: the CPP if a purchase landed right
   now, which is the best it can still turn out (`metrics.js › comparableCpp`). An ad that has
   already spent past the ceiling without converting reads as outside, while one still under it
   isn't condemned for not having converted yet. Cohort ads' slow-start days are read the same
   way, so they widen the early ceiling.
2. **Days after day 10** get `status`/`remark` `beyond_benchmark_window` and no verdict, because
   the curve stops at the horizon. Most live ads are older than 10 days, so this is the first
   thing to decide before this goes on the dashboard.
3. **A trajectory with no baseline** (an ad's first day past the floor) is `unknown`, read as `flat`
   for the remark. That's the cautious choice: it never earns `scale_candidate` or `hold`.
4. **`outside` with high runway** says `wait_one_more_day` every day until runway drops to 3, as
   the table specifies. An ad that is outside from day 1 therefore waits six days before
   `pause_candidate`. Lower `runway.lowMaxDays` or change the table if that's too patient.
5. **Hindsight**: when old days are re-scored against today's curve, a cohort ad's early days are
   measured against a curve it helped build. That's fine for monitoring live ads, but not a clean
   backtest.

## Placeholders to replace with real numbers

- `margin.earlyStart` (0.30) and `margin.taperDays` (5): set these from the cohort's actual
  day-by-day spread once the history exists. The curve output reports `sampleSize` and the
  ceilings per day to help with that.
- `floor.minCumSpend`: 150, the top of the ₹100–150 range given.

## Blocked on: lifetime ad history

The input above **doesn't exist yet**, and nothing in this module pretends otherwise. As of
2026-09-11:

- `ad_snapshots` is wiped and rewritten daily and only holds each ad's **last 10 days**. An ad
  older than that has no day 1, so the successful cohort (ads that ran 10+ days, measured from
  day 1) can't be built. The input validator rejects exactly this: a history that doesn't start
  at day 1.
- There is no `product` column. Product is inferred from campaign-name keywords, and that keyword
  list has no entry for **Adi Anku**.

Before wiring this in, a separate task needs to start keeping per-ad daily history from each ad's
first day, with a product assigned. The defaults in `DEFAULT_PRODUCT_GOALS` equal the 10-day columns
of `ad_closing_threshold`. That table can be edited from the dashboard, so the wiring should pass
the live values in as `goals`.
