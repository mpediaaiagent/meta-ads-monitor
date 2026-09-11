# Monthly benchmark refresh

Keeps the D1 tables behind the ad-level Keep/Pause current. These are raw daily numbers for the
last 3 months of **successful** ads: ads that spent on their day 11 or later, counting day 1 as
their first day with spend.

It runs as the scheduled task **"Meta Ads — monthly benchmark refresh (benchmark_ads)"** on the 1st
of every month. A cloud session checks out this repo and relays the Meta and D1 calls, and these
scripts do everything else:
- parsing and bucketing the Meta responses
- verifying each call's row count
- deciding which ads are successful, using `lib/cpp-benchmark`, the same code the dashboard uses
- generating the SQL

The task's prompt is only the wiring. The logic lives here, where it is tested.

## Tables (raw data only)

```
benchmark_ads        one row per successful ad
  ad_id PK, ad_account, campaign_name, adset_name, ad_name,
  ad_created_date (YYYY-MM-DD, account time zone), run_date (the run that added it), created_at

benchmark_ad_daily   that ad's days 1–11, zero days included
  ad_id, date, spend, purchases          PRIMARY KEY (ad_id, date)

benchmark_runs       one row per completed run — the next run starts where the last one stopped
  run_date PK, window_since, window_until, created_from, created_to,
  candidates, ads_added, ads_removed, notes, finished_at
```

- Nothing computed is stored: no cumulative totals, no CPP, no product, no benchmark values.
- `/api/ads` classifies the product from `campaign_name` and builds the benchmarks on every request.
- `purchases` is Meta's `results`. Every result in the backfill was `offsite_conversion.fb_pixel_purchase`.

## How a run works

Each run is **incremental**. It processes only the ads created since the last run's `created_to`,
up to `until − 14 days`: newer ads haven't had their day 11 inside the data yet, so they wait for
next month. It also drops ads created before `run date − 3 months`. The table therefore always
holds about 3 months of ads, and a monthly run pulls about a month of data instead of three.

| step | script | what it does |
|---|---|---|
| 1 | `window.mjs --run-date= --last-created-to=` | window and slice dates → `window.json` |
| 2 | *(task)* | list ads created in the slice, paginating with the cursor |
| 3 | `plan.mjs tb=<page> tp=<page> …` | candidates (created in slice, spent > 0) and the daily-data calls → `plan.json` |
| 4 | `show.mjs <key>` / `rec.mjs <key>=<file>` / `status.mjs` | one Meta call per key, each checked on arrival |
| 5 | `build.mjs` | successful ads → `sql/NN-*.sql` (≤15 KB each) and `build.json` with expected counts |
| 6 | *(task)* | staging tables → count gate → insert into live → prune → `benchmark_runs` row |

Scratch files go to `/tmp/benchmark-refresh`; pass `--work=<dir>` to change that. Nothing is
written into the repo.

## Meta API behaviour this depends on (all verified 2026-09-11)

- **Listing ads** (`level=ad`, filtered on `ad.created_time` with `GREATER_THAN` and `LESS_THAN`)
  returns up to 1000 per page **with** a `next_cursor`. The date filters are padded by a day on
  each side because Meta may compare in UTC. `plan.mjs` applies the exact dates in the account's
  time zone.
- **Daily data** (`time_increment: "1"`, filtered on `ad.id IN [...]`) is cut off at `limit` with
  **no cursor and no error**. The first backfill attempt lost half of two calls this way. So
  `plan.mjs` sizes every call to fit one 1000-row response.
- Daily data has **one row per ad per day in the range, zero days included**, even days before the
  ad existed. That makes each call's row count exactly `ads × days`, and `rec.mjs` rejects anything
  else. This check caught the truncation above.
- Small responses come back inline instead of saved to a file, so `plan.mjs` pads a small call to
  at least 450 rows by starting its range earlier. The extra rows are pre-creation zeros.
- `amount_spent` is a formatted string (`"₹1,234.56 INR"`). A zero-purchase day has
  `results.value = "Not available"` and no `values` array.
- Purchases can land on a day with ₹0 spend (attribution). They count on that day.

## The one-time backfill (2026-09-11)

The backfill was run by hand for ads created 2026-06-11 → 2026-08-27. It listed 3,834 ads, of
which 3,287 were candidates that took 82 daily-data calls, and 478 were successful: trubuddy 420,
mpedia 30, gulu 17, educator program 10, adi anku 1. That produced 5,258 daily rows. 4 ads started
delivering too late to judge and were left out.

Re-running these scripts on the same Meta data reproduces the loaded rows exactly.

## Re-running or testing by hand

- **Dry run:** fire the task with the text `dry_run created_from=2026-08-21 created_to=2026-08-27`.
  It goes through every step, writes nothing, and compares its result with what is already stored.
- **Redo a failed month:** delete that month's `benchmark_runs` row (if the run got that far) and
  fire the task again. Every write is `INSERT OR REPLACE` on the tables' keys, so a repeat is safe.
