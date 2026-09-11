# cpp-benchmark

The calculation behind the **ad-level Keep/Pause** in the adset drill-down. It's pure code, with
no I/O:

1. **`buildBenchmarks(successfulAds)`** turns the last 3 months of successful ads into per-product
   benchmarks.
2. **`evaluateAd(daily, benchmark)`** judges one ad, day by day, through its first 9 days.

`functions/api/ads.js` calls both on every drill-down request, reading raw rows from D1. The
monthly refresh (`scripts/benchmark-refresh/`) uses the same `alignFromFirstSpend` and
`isSuccessful` to decide which ads get stored, so "day 1" and "successful" mean exactly the same
thing on both sides.

```
src/
├── index.js       public API and every output enum
├── config.js      every tunable number, and the campaign-name → product keywords
├── history.js     raw daily rows → day 1 (first day with spend), day 2, … with running totals
├── benchmark.js   successful ads → per-product CPP benchmark per day + first-purchase limit
├── evaluate.js    one ad → Keep/Pause per day
├── statistics.js  swappable statistics (max, percentile)
└── constants.js   VERDICT, REASON, STATUS, BENCHMARK_KIND, SCHEMA_VERSION
test/              node:test — `npm test` in this folder (Node 18+, nothing to install)
```

## The rules

**Which ads count as successful.** An ad counts if it spent on its day 11 or later, where day 1 is
its first day with spend. No CPP filter is applied: an ad kept running past day 10 was kept for a
reason. The monthly refresh stores the last 3 months of these ads.

**Product.** Product is read from the campaign name: `trubuddy`, `mpedia`, `gulu`, `educator` (→
educator program), and `adi-anku` (→ adi anku). A name that matches none or several of these is
unclassified and never judged. **Products never mix.** Each product's benchmark comes only from
its own ads, with no fallback to another product.

**Two benchmarks per product:**
- **CPP benchmark for each of days 1–9.** This is the highest cumulative CPP any successful ad had
  on that day, plus a flat **10%**. Only ads with at least one purchase by that day count, because
  CPP doesn't exist before a purchase.
- **First-purchase limit.** This is the most any successful ad spent up to and including the day
  of its first purchase, with **no margin**. Only the first 9 days count: an ad that first bought
  on day 20 contributes what it had spent by day 9. Ads that never bought in those 9 days still
  count, with their day-9 spend.

**Keep/Pause, for ads on days 1–9:**

| the ad on day *d* | Pause when | otherwise |
|---|---|---|
| no purchase yet | spend > first-purchase limit | Keep |
| 1+ purchases | cumulative CPP > day-*d* benchmark × 1.10 | Keep |
| no benchmark to compare with | — | Keep (`no_benchmark`) |

A value exactly on the line is not above it, so it gets Keep. The ad's current verdict is its
latest day's verdict. From day 10 the ad is `past_incubation` and gets no verdict here, because the
adset-level rule covers it. Its days 1–9 are still returned so the dashboard can show them.

## Output of `evaluateAd`

```js
{
  status: "incubation",            // | "past_incubation" | "not_started"
  ageDays: 4, firstSpendDate: "2026-09-07",
  verdict: "Pause",                // "Keep" | "Pause" | null — the latest day's; null unless incubation
  reason: "cpp_above_benchmark",   // see REASON
  days: [                          // days 1..min(age, 9)
    { day: 1, date: "2026-09-07", cumSpend: 90.22, cumPurchases: 0, cumCpp: null,
      verdict: "Keep", reason: "within_first_purchase_limit",
      benchmark: { kind: "first_purchase_limit", limit: 887.18, sampleSize: 420 } },
    …
    { day: 4, date: "2026-09-10", cumSpend: 1220.8, cumPurchases: 1, cumCpp: 1220.8,
      verdict: "Pause", reason: "cpp_above_benchmark",
      benchmark: { kind: "cpp", ceiling: 1013.13, margin: 0.1, upperBound: 1114.44, sampleSize: 138 } },
  ],
}
```

Every key is always present, and everything is plain JSON. `REASON` values are
`cpp_above_benchmark`, `within_cpp_benchmark`, `spend_without_purchase`,
`within_first_purchase_limit` and `no_benchmark`.

## Tuning

Every number lives in `config.js` and can be overridden per call, e.g.
`buildBenchmarks(ads, { cppMargin: 0.15, ceilingStatistic: STATISTICS.percentile(90) })`. The
settings are `successMinDays` (11), `incubationMaxDay` (9), `cppMargin` (0.10),
`ceilingStatistic` / `firstPurchaseStatistic` (max), and `products`. Unknown keys throw.

### What the highest-value rule gives on the first backfill (2026-09-11)

| product | successful ads | first-purchase limit | CPP benchmark, days 1→9 (before +10%) |
|---|---|---|---|
| trubuddy | 420 | ₹887 | 303 · 524 · 622 · 1013 · 799 · 622 · 467 · 454 · 887 |
| mpedia | 30 | ₹738 | 132 · 364 · 323 · 369 · 196 · 194 · 233 · 207 · 207 |
| gulu | 17 | ₹622 | 55 · 483 · 373 · 168 · 142 · 148 · 177 · 173 · 143 |
| educator program | 10 | ₹884 | 71 · 198 · 249 · 349 · 442 · 305 · 320 · 419 · 507 |
| adi anku | 1 | ₹211 | 70 · 142 · 143 · 138 · 143 · 165 · 165 · 164 · 190 |

**Large cohorts make "highest" lenient.** 265 of TruBuddy's 420 successful ads had no purchase in
their first 9 days, so one slow-starting ad sets the day-4 line (₹1,013). With the 90th percentile
instead, TruBuddy's lines would be 170 · 308 · 290 · 373 · 312 · 306 · 312 · 324 · 340 and its
first-purchase limit ₹331. Switching is the one-line override shown above.

**Small cohorts make it fragile.** Adi Anku's benchmark is a single ad. Gulu's day 1 rests on 2.
