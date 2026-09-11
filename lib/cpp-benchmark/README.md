# cpp-benchmark

The calculation behind every Keep/Pause on the dashboard. It's pure code, with no I/O, and it's
tested:

1. **`buildBenchmarks(successfulAds, { maxCppByProduct })`** turns the last 3 months of successful
   ads into per-product benchmarks.
2. **`evaluateAd(daily, benchmark)`** judges an ad day by day through its first 9 days.
3. **`judgeWindow(totals, benchmark, maxCpp)`** judges an older ad on its last 10 days.
4. **`rollUpAdset(ads)`** turns an adset's ad verdicts into the adset's Advise.
5. **`adsetFirstPurchase(ads, benchmark, { through })`** checks how many days the adset took to its
   first purchase against the slowest successful ad.

`lib/dashboard/advise.js` reads the raw rows from D1 and calls these for `/api/snapshots`,
`/api/ads` and `/api/thresholds`. Its `judgeAdset` combines 1–5 for one adset. The monthly refresh (`scripts/benchmark-refresh/`) uses the same
`alignFromFirstSpend` and `isSuccessful` to decide which ads get stored, so "day 1" and "ran 11+
days" mean exactly the same thing everywhere.

```
src/
├── index.js       public API and every output enum
├── config.js      every tunable number, and the campaign-name → product keywords
├── history.js     raw daily rows → day 1 (first day with spend), day 2, … with running totals
├── benchmark.js   successful ads (+ threshold) → per-product CPP line per day + first-purchase limit
├── evaluate.js    one ad → Keep/Pause per incubation day (evaluateAd), or on its window (judgeWindow)
├── adset.js       an adset's ads → the adset's Advise (rollUpAdset), and its first-purchase check
├── statistics.js  swappable statistics (max, percentile)
└── constants.js   VERDICT, REASON, STATUS, BASIS, BENCHMARK_KIND, SCHEMA_VERSION
test/              node:test — `npm test` in this folder (Node 18+, nothing to install)
```

## The rules

**Product.** Product is read from the campaign name: `trubuddy`, `mpedia`, `gulu`, `educator` (→
educator program), and `adi-anku` (→ adi anku). A name that matches none or several of these is
unclassified and never judged. **Products never mix.** Each product's numbers come only from its
own ads, with no fallback to another product.

**The threshold (one number per product).** It is edited on the dashboard and stored in D1's
`benchmark_thresholds`. The first values were 280 for everything except educator program at 700.
It is passed in as `maxCppByProduct`.

**Successful ads (the benchmark's sample).** An ad counts when both of these hold:
- it spent on its day 11 or later (day 1 is its first day with spend);
- its cumulative CPP **at day 10** is at or under its product's threshold. That also means it
  needs at least one purchase by day 10.

The monthly refresh stores every 11+ day ad whatever its CPP. The threshold is applied when the
data is read, so changing it takes effect immediately.

**Three benchmarks per product, from those ads:**
- **CPP line for each of days 1–9.** This is the highest cumulative CPP any successful ad had on
  that day, plus a flat **10%**. Only ads with a purchase by that day count.
- **First-purchase limit.** This is the most any successful ad spent up to and including the day
  of its first purchase, with **no margin**. Only the first 9 days count.
- **First-purchase day limit** (`firstPurchaseDayLimit`). This is the latest day on which any
  successful ad made its first purchase, reading days 1–10. Every ad under a threshold has one by
  day 10. With no threshold, an ad might not; then the worst case is unknown and the limit is
  `null`, rather than set too low.

**Each ad's verdict:**

| the ad | Pause when | otherwise |
|---|---|---|
| day *d* ≤ 9, no purchase yet | spend > first-purchase limit | Keep |
| day *d* ≤ 9, 1+ purchases | cumulative CPP > day-*d* line × 1.10 | Keep |
| past day 9, purchases in the last 10 days | 10-day CPP > product threshold | Keep |
| past day 9, no purchase in the last 10 days | 10-day spend > first-purchase limit | Keep |
| nothing to compare with | — | Keep (`no_benchmark`) |

A value exactly on a line is not above it, so it gets Keep. An ad created before the 10-day window
is certainly past day 9, so it is judged on its window too.

**The adset's Advise:** Pause if **at least one running ad** is Pause, Keep if every running ad
with a verdict is Keep, and none (`–`) if no running ad has a verdict. Ads already paused, deleted
or archived in Meta are left out, so an ad you've already switched off doesn't make its adset read
Pause.

**Slow first purchase overrides that.** `adsetFirstPurchase` adds up all the adset's ads by date,
paused ones included, and counts day 1 from the first day any of them spent. The adset is Pause
(`adset_first_purchase_too_slow`) in either case:
- its first purchase came after the day limit;
- it has run more days than the limit with no purchase.

Otherwise it is in time (`adset_first_purchase_in_time`). Then the adset **and every ad in it** are
Pause (`basis: "adset"`). The caller runs the check only when its data covers the adset's whole
life. The dashboard requires every ad to have started inside the 10-day window.

## Output

`evaluateAd` returns:

```js
{
  status: "incubation",            // | "past_incubation" | "not_started"
  ageDays: 4, firstSpendDate: "2026-09-07",
  verdict: "Pause",                // the latest incubation day's; null unless status is incubation
  reason: "cpp_above_benchmark",
  days: [                          // days 1..min(age, 9) — also returned for past_incubation ads
    { day: 4, date: "2026-09-10", cumSpend: 1220.8, cumPurchases: 1, cumCpp: 1220.8,
      verdict: "Pause", reason: "cpp_above_benchmark",
      benchmark: { kind: "cpp", ceiling: 496.35, margin: 0.1, upperBound: 545.99, sampleSize: 102 } },
  ],
}
```

`judgeWindow` returns the verdict for older ads:

```js
{ spend: 2938.01, purchases: 20, cpp: 146.9, verdict: "Keep", reason: "within_window_threshold",
  benchmark: { kind: "window_threshold", threshold: 280 } }
```

`adsetFirstPurchase` returns:

```js
{ verdict: "Pause", reason: "adset_first_purchase_too_slow", limit: 3, sampleSize: 9,
  firstSpendDate: "2026-09-07", ageDays: 4, firstPurchaseDate: "2026-09-11", firstPurchaseDay: 5 }
```

The API merges the two into one `advise` per ad:
- `basis: "incubation" | "window" | "adset"` says which rule the current verdict came from.
  `"adset"` means the adset's slow first purchase put it on Pause.
- `own` holds the ad's own `{ basis, verdict, reason }` when the adset overrode it, and is `null`
  otherwise.
- `window` holds the judgeWindow result.
- `startedBeforeWindow` is set for ads created before the 10-day window.

Every key is always present, and everything is plain JSON. `REASON` values are:
`cpp_above_benchmark`, `within_cpp_benchmark`, `spend_without_purchase`,
`within_first_purchase_limit`, `window_cpp_above_threshold`, `within_window_threshold`,
`adset_first_purchase_too_slow`, `adset_first_purchase_in_time` and `no_benchmark`.

## Tuning

Every number lives in `config.js` and can be overridden per call, e.g.
`buildBenchmarks(ads, { maxCppByProduct: {...}, ceilingStatistic: STATISTICS.percentile(90) })`.
The settings and their defaults:
- `successMinDays` (11), `successCppDay` (10), `incubationMaxDay` (9)
- `cppMargin` (0.10)
- `ceilingStatistic` / `firstPurchaseStatistic` / `firstPurchaseDayStatistic` (max)
- `maxCppByProduct` (none: no filter), `products`

Unknown keys throw.

### What the thresholds give (2026-09-11 data, ₹280 / educator ₹700)

| product | successful / ran 11+ days | first-purchase limit | CPP line, days 1→9 (before +10%) |
|---|---|---|---|
| trubuddy | 119 / 420 | ₹814 | 303 · 524 · 616 · 496 · 799 · 401 · 467 · 367 · 320 |
| mpedia | 19 / 30 | ₹738 | 132 · 364 · 323 · 369 · 196 · 194 · 233 · 207 · 207 |
| gulu | 9 / 17 | ₹622 | 55 · 483 · 373 · 168 · 142 · 148 · 177 · 173 · 143 |
| educator program | 10 / 10 | ₹884 | 71 · 198 · 249 · 349 · 442 · 305 · 320 · 419 · 507 |
| adi anku | 1 / 1 | ₹211 | 70 · 142 · 143 · 138 · 143 · 165 · 165 · 164 · 190 |

Before the filter, TruBuddy used all 420 ads and its day-4 line was ₹1,013. With ₹280 it is ₹496.
The lines still come from the single highest ad on each day, so one successful ad with a slow day 5
(₹799) still sets that day. If that proves too loose, `STATISTICS.percentile(90)` is the next lever.
Adi Anku's benchmark is still one ad.
