# Ads Monitor (dashboard title: "Keep or Pause")

**Read this entire doc before touching anything.** It's written so a Claude Code session with zero memory of building this can pick it up and keep going.

## What this is

A live dashboard showing a Keep/Pause recommendation for every active Meta (Facebook) adset across two ad accounts: **Tuhin Paul** (`807109673203041`) and **TruBuddy** (`949249031427990`).

**Every verdict starts at the ad.** Clicking an adset opens its ads, and each ad gets its own
Keep/Pause:
- **Ads in their first 9 days** are compared, day by day, with the same product's successful ads
  from the last 3 months, on cumulative CPP — and **with no purchase, the spend itself is the CPP**,
  so an unconverted ad faces both that line and the first-purchase spend limit. Day 1 is immune.
- **Older ads** are compared on their last 10 days' CPP against the product's threshold.

The adset's Advise then follows its ads: **Pause if at least one running ad is Pause, Keep only if
they all are.** Three adset-level rules are OR'd on top of that (see section 10): **an adset whose
first purchase takes more days than the slowest successful ad took is Pause, and so is every ad
under it**; **an adset whose own cumulative CPP is above what past adsets of that product had on the
same day is Pause**; and **an adset that has spent more before its first purchase than past adsets
did is Pause**. The last two don't touch their ads' verdicts, and all three make the adset's pill
red. The two numbers per product that drive all of this (a CPP threshold and an optional
spend-with-no-purchase threshold) are editable on the dashboard.

Live at: **https://meta-ads-monitor.pages.dev/**

This is one of several independent tools linked from the hub page at https://meta-ads-tools.pages.dev/ — see that repo's own README (`mpediaaiagent/meta-ads-tools`) for the overall multi-tool architecture and why every tool lives in its own separate Cloudflare Pages project. **Do not merge this project with any other tool's project or repo.**

## Architecture

- **Cloudflare Pages** project (`meta-ads-monitor`), Git-connected to this repo for auto-deploy — pushing to `main` triggers a build and publish automatically. No manual `wrangler pages deploy` should be needed once that connection is confirmed live (check Settings → Build & deployments in the Cloudflare dashboard if unsure).
- **Cloudflare D1** database `meta-ads-report` (database_id `49a148d0-1f38-4ebb-9885-6c5ee40f995e`), bound as `DB` in `wrangler.toml`. This is the *only* backend — no other database, and no external API calls at request time.
- **Pages Functions** in `functions/api/`:
  - `snapshots.js` — `GET` returns all rows from `adset_snapshots` for `team = 'marketing'`, ordered by account then 10-day cost descending.
    - Each row's `advise` is **rolled up from that adset's ads**; the daily task's stored value is not used.
    - `adviseDetail` says which running ads are on Pause.
    - If the ad-level data can't be loaded, it returns the stored daily-task value instead, with `adviseSource: "daily_task_fallback"`, and the page shows a warning.
  - `thresholds.js` — `GET` returns the per-product thresholds from `benchmark_thresholds` (`max_cpp` and the optional `max_spend_no_purchase`), each with how many stored 11+ day ads it lets into the benchmark and the derived spend-with-no-purchase limit that an empty field falls back to. `POST` updates **one** product's row (the dashboard's single Save button fans out one request per product — see below); a blank `max_spend_no_purchase` clears it to NULL, anything non-blank must be a number above 0.
  - `ads.js` — `GET /api/ads?account=&adset=&campaign=` returns every ad in one adset with its day-by-day spend and conversions, for the adset drill-down. LEFT JOINs `ad_thumbs`, so each ad also carries a `thumb` link (null when the thumbnail task hasn't reached it).
    - It also returns each ad's Keep/Pause (`advise`), the adset's verdict (`adsetAdvise`, including its `firstPurchase` check), and a `benchmark` summary.
    - All three are computed on every request from raw D1 rows.
    - `campaign` is optional but should always be sent: Meta reuses adset names across campaigns, and the campaign name also decides the product.
- **`lib/dashboard/advise.js`**: the D1 side of the Keep/Pause, shared by all three functions above so they always agree. It reads the thresholds and the stored successful ads, builds the benchmarks and judges ads.
- **Frontend**: `public/index.html`, a single self-contained file (inline CSS + JS, IBM Plex Mono / Manrope from Google Fonts, no build step, no other dependencies).
- **`lib/cpp-benchmark/`**: the pure calculation behind every verdict, with no I/O and tested. It covers:
  - the benchmarks, built from the last 3 months of successful ads under each product's threshold
  - the day-by-day verdict for ads in their first 9 days
  - the 10-day verdict for older ads
  - the adset roll-up

  The functions import it, which is fine because Pages bundles relative imports. It lives outside `functions/` on purpose, because every file there becomes a live route. Its [README](lib/cpp-benchmark/README.md) has the rules, the output and the tunable settings.
- **`scripts/benchmark-refresh/`**: the scripts the monthly benchmark task runs (see below). They are never deployed; Pages only serves `public/` and `functions/`.

There is no build step. The only tests are the calculation module's: run `npm test` in `lib/cpp-benchmark/` (built-in `node:test`, nothing to install). The dashboard itself has no test suite. To test the API and page against real data, copy D1 locally and run the real Pages Functions: `npx wrangler d1 export meta-ads-report --remote --output=dump.sql`, then `npx wrangler d1 execute meta-ads-report --local --file=dump.sql`, then `npx wrangler pages dev public`. To verify a frontend change, render the page and interact with it — do not just eyeball the CSS. The quickest loop is to copy `public/index.html` somewhere temporary, stub `window.fetch` with sample `snapshots` / `thresholds` / `ads` responses, and serve that directory over plain HTTP (e.g. `npx http-server`); that exercises layout, sticky columns, column resizing, drag-to-pan, the drill-down, the panel toggle and the save flow without needing D1.

## Data pipeline — how the D1 table actually gets populated

This dashboard does **not** pull from Meta's API directly. A separate scheduled task called **"Daily Meta Ads Report — Direct to D1"** (cron `30 2 * * *`, trigger id `trig_019hg5R68FYS1PgdFckLGZEk` as of this writing) runs once a day, wipes `adset_snapshots` for `team = 'marketing'`, and re-inserts a fresh snapshot for every currently-active adset across both accounts. That task's full prompt lives in the scheduled task itself (use `list_triggers` / `update_trigger` on the Claude Code Remote MCP to read or edit it) — it is long and detailed; read it before assuming you know how a value is computed.

That task still works out its own adset "Advise" (the old 5/10-day threshold rule, reading
`ad_closing_threshold`) and stores it in `adset_snapshots.advise`. **The dashboard no longer shows
it.** It is only a fallback for when the ad-level data can't be loaded; see "Adset Advise follows
its ads" below.

A second, older, parallel task called **"Daily Meta Ads Report"** builds the same data as a Google Sheet instead of writing to D1. It is intentionally left alone and untouched by the D1 task. **That Sheet is the trusted cross-check** — if the dashboard's numbers ever look wrong (missing adsets, wrong counts), compare against that day's Sheet before assuming the dashboard's D1 data is correct.

### The second scheduled task: ad-level refresh

`ad_snapshots` is refreshed by its **own** scheduled task, separate from the adset one:

**"Meta Ads — ad-level refresh (ad_snapshots)"** — trigger id `trig_01U1jiEfav58E2NdbJ5wvcbv`,
cron `30 3 * * *` (03:30 UTC / 09:00 IST), model claude-sonnet-5, with the
`Cloudflare_Developer_Platform` and `Meta_MCP` connectors attached.
Manage it at https://claude.ai/code/routines/trig_01U1jiEfav58E2NdbJ5wvcbv

It runs **one hour after** the 02:30 UTC adset task and depends on it: it reads the adset list
straight out of `adset_snapshots` and fills in the ads belonging to those adsets, stamping the same
`report_date` so the two tables stay in lockstep. It writes to `ad_snapshots` and nothing else.

If the drill-down's numbers look stale, check `SELECT DISTINCT report_date FROM ad_snapshots` first —
if it lags `adset_snapshots`, that task either aborted or failed, and its run log will say which.

The task's full prompt lives in the routine itself. The rest of this section is what that prompt
encodes — read it before editing the prompt, because most of it is hard-won:

1. **Window**: the same 10 complete days the adset rows use — `since` = report_date − 10 days,
   `until` = report_date − 1 (for report_date 2026-09-10 that is 2026-08-31 → 2026-09-09).
   This was confirmed by dividing adset spend by conversions over that window and matching
   `cost_10d` to the paisa. Use a different window and the drill-down stops reconciling with the
   row above it. The 5-day figures are the last 5 days of that same window.
2. **Find the adsets' ids**: `ads_get_ad_entities` at `level=adset`. Filtering adset **names**
   needs `CONTAINS_ANY` — the `IN` operator is rejected on `adset.name`. Match the results back to
   the dashboard's rows on **name + campaign_name**: names repeat across campaigns (one name had
   14 historical adsets), so name alone picks the wrong adset.
3. **Fetch the ads**: `level=ad`, `time_increment: "1"`, fields
   `[name, adset_name, campaign_name, spend, results, created_time, effective_status]`, filtered
   with `{field: "adset.id", operator: "IN", value: [...]}`. This is the only filter that reliably
   scopes the pull — an unfiltered account-level pull walks the account's entire ad history
   (hundreds of ads, many pages), and a `spend > 0` filter is silently ignored.
4. **Batch it**: a response is capped at **1000 rows and returns no pagination cursor**, so an
   over-large request is silently truncated — it just stops, mid-adset, with no error. At 10 days
   per ad that is 100 ads per call. Batches of 5–6 adsets are comfortable. The first attempt here
   returned exactly 1000 rows for both accounts and quietly dropped 4 adsets entirely; the tell is
   a suspiciously round row count.
5. **Parse carefully**: `amount_spent` comes back as a formatted string (`"₹1,234.56 INR"`, with a
   non-breaking space) — strip everything but digits and the decimal point. Conversions are
   `results.values[0].value` as a string, and a zero-conversion day is `results.value ===
   "Not available"` with no `values` array at all.
6. **Verify before writing**, the same way the backfill did: group the ads by adset and check
   conversions and spend ÷ conversions against `adset_snapshots`. 41 of 43 adsets matched exactly;
   the 2 that didn't were off by one conversion — see "Adset drill-down" below for why that is
   expected rather than a bug.
7. **Abort rather than write something wrong.** The task refuses to write at all if fewer than 90%
   of the adsets came back with ads, if any batch is still suspected truncated, or if more than 20%
   of adsets miss the conversion check by more than 2. A stale-but-complete table beats a
   half-wiped one, and the previous day's snapshot stays in place. The task's summary must name
   every adset that ended with zero ads and every batch that errored — silence is exactly how the
   adset undercount bug below hid itself.

### The fourth scheduled task: ad thumbnail refresh

**"Meta Ads — ad thumbnail refresh (ad_thumbs)"** — trigger id `trig_01WDHJMrAmW7FV4FQtvEYUgc`,
cron `30 4 * * *` (04:30 UTC / 10:00 IST), model claude-sonnet-5, with the
`Cloudflare_Developer_Platform` and `Meta_MCP` connectors. Created 2026-09-12.
Manage it at https://claude.ai/code/routines/trig_01WDHJMrAmW7FV4FQtvEYUgc

It runs **one hour after** the 03:30 ad-level task so it sees that day's fresh ad list, and it
writes to exactly one table: `ad_thumbs`.

- **It re-fetches every ad every run**, not just new ones. That is the whole point: Meta's links
  expire after roughly four days, so a catch-up-only task would leave the column slowly going blank.
- **It is deliberately the timid one.** A missing thumbnail costs nothing — the dashboard shows a
  placeholder and every number still works — so the prompt tells it that when anything goes wrong it
  should do *less*, never delete rows to "start clean", and never leave `ad_thumbs` emptier than it
  found it.
- **Why it is separate from the 03:30 task**, which already enumerates every ad and could have done
  this in one extra field. That task aborts rather than write bad data, and a cosmetic feature must
  never be able to block the spend numbers. A separate routine can fail as often as it likes.
- The one way it can do real harm is a wrong `ad_id → creative_id → thumbnail_url` join, which would
  show the wrong creative against an ad. The prompt calls that out and forbids matching on ad *name*
  — names repeat across ads with different creatives.

### The third scheduled task: monthly benchmark refresh

**"Meta Ads — monthly benchmark refresh (benchmark_ads)"** runs at 04:30 UTC on the 1st of every
month. It uses the `Cloudflare_Developer_Platform` and `Meta_MCP` connectors and checks out this
repo. It keeps `benchmark_ads` / `benchmark_ad_daily` holding the last 3 months of **successful**
ads (ads that spent on their day 11 or later), which the ad-level Keep/Pause in the drill-down is
measured against.

- It is incremental. Each run adds the ads created since the last run's `created_to`, drops those
  older than 3 months, and records itself in `benchmark_runs`.
- The logic lives in `scripts/benchmark-refresh/`, which uses the same `lib/cpp-benchmark` code as
  the API. The task's prompt only relays Meta and D1 calls.
- Read [scripts/benchmark-refresh/README.md](scripts/benchmark-refresh/README.md) before changing
  it. It records the Meta API behaviour it depends on: the ad-level daily pull truncates at 1,000
  rows with no cursor, and every call is checked on its exact expected row count.
- The first 3 months (ads created 2026-06-11 → 2026-08-27) were backfilled by hand on 2026-09-11.

If the drill-down's Advise column looks stale or empty, check
`SELECT * FROM benchmark_runs ORDER BY run_date DESC` first.

### Adset undercount bug — already found and fixed; know this before debugging a similar issue

On 2026-09-09 the D1 task under-counted adsets: it wrote 37 rows (25 Tuhin Paul + 12 TruBuddy) against an actual, correct 55 (32 + 23), confirmed against that day's Sheet.

Root cause: the task's mandatory "verify each row's spend independently before including it" step treated a **failed or errored verification API call** exactly the same as a **confirmed genuine zero-spend adset** — in both cases the row was silently dropped. So every transient API error quietly deleted a real adset from the day's snapshot, with nothing in the output to indicate it had happened.

Fix applied: the task's prompt was rewritten so that a verification call which errors or times out is retried once before the row is dropped, and any row still dropped after both attempts is **named explicitly in the task's final summary** rather than silently vanishing from the count. That day's missing 18 rows were also manually backfilled into D1 from the Sheet's data to correct the historical snapshot.

If the dashboard's adset count ever looks suspiciously low again: check that day's Sheet first, then check whether this retry-and-report logic is still intact in the scheduled task's prompt.

## Database schema

`adset_snapshots` — one row per adset per day (the table is wiped and fully rewritten daily; it holds only the latest snapshot, not history):

```
id (auto), team (TEXT, always 'marketing'), report_date (TEXT, YYYY-MM-DD),
advise (TEXT, 'Keep' or 'Pause'), ad_account (TEXT, 'Tuhin Paul' or 'TruBuddy'),
adset_status (TEXT, always 'Active'), adset_name (TEXT), campaign_name (TEXT),
cost_5d (REAL), cost_10d (REAL), age_days (INTEGER),
conv_5d (INTEGER), conv_10d (INTEGER), created_at (auto)
```

`ad_snapshots` — one row per **ad**, backing the adset drill-down (same wipe-and-rewrite model as `adset_snapshots`):

```
id (auto), team (TEXT, always 'marketing'), report_date (TEXT, YYYY-MM-DD),
ad_account (TEXT), adset_name (TEXT), campaign_name (TEXT),
ad_id (TEXT), ad_name (TEXT), ad_status (TEXT, ACTIVE/PAUSED/ADSET_PAUSED),
ad_created_date (TEXT, YYYY-MM-DD — the ad's start date),
spend_5d (REAL), conv_5d (INTEGER), spend_10d (REAL), conv_10d (INTEGER),
daily_json (TEXT), created_at (auto)
UNIQUE(ad_account, adset_name, campaign_name, ad_id)
```

`daily_json` is the day-by-day series as a JSON array, oldest first, one entry per day of the
10-day window: `[{"d":"2026-08-31","s":123.45,"c":2}, …]` — `d` date, `s` spend, `c` conversions.
Ten entries per ad. It is stored as JSON rather than a second table so the drill-down is a single
indexed lookup with no join, and so the daily task writes one row per ad instead of eleven.

A row joins to its adset row on `(ad_account, adset_name, campaign_name)` — the same triple
`adset_snapshots` is unique on.

`ad_thumbs` — the ad's creative thumbnail, shown as a column in the drill-down. Added 2026-09-12.
**Not** wiped daily, unlike the snapshot tables:

```
ad_id (TEXT PK), creative_id (TEXT), thumb_url (TEXT), image_url (TEXT),
object_type (TEXT, VIDEO/SHARE/...), fetched_at (TEXT)
```

- **Where the link comes from.** Two Meta calls: `ads_get_ad_entities` at `level=ad` gives each ad's
  `creative_id` (that is the only creative field available at ad level), then `ads_get_creatives`
  with those ids and `fields=[id, thumbnail_url, object_type]` gives the link.
- **`thumbnail_url` is capped at 64×64** — the `p64x64` in its `stp` parameter. That is why the
  table shows it at 36px and the hover zoom stops at 1.75x: any more and it just goes soft. For
  image creatives `image_url` is full size; video creatives have none, so the column uses
  `thumbnail_url` for everything and stays consistent.
- **The links expire.** Every URL carries an `oe=` expiry, so a thumbnail that worked yesterday can
  404 tomorrow. The UI treats that as normal: an `error` handler swaps the image for the same
  neutral placeholder an unfetched ad gets, and the hover says the link expired. **It never shows a
  broken-image icon.** This is the one thing to understand before "fixing" a missing thumbnail.
- **Kept current by its own 04:30 task** (see "The fourth scheduled task" above). `/api/ads` LEFT
  JOINs the table, so a missing or stale row costs the drill-down nothing either way.

`benchmark_thresholds` — one row per product, **edited from the dashboard's "Edit Thresholds" panel**:

```
product (TEXT PK, lower-case: 'trubuddy', 'mpedia', 'gulu', 'educator program', 'adi anku'),
max_cpp (REAL), max_spend_no_purchase (REAL, nullable), updated_at (TEXT)
```

Two thresholds per product, for the two ways an ad can fail. Both are read on every request, so a
save applies at once.

`max_cpp` — applies once an ad **has** purchases, and is used two ways:
- **Benchmark filter:** an 11+ day ad counts as successful only if its cumulative CPP at day 10 is
  at or under it.
- **Older ads:** an ad past day 9 is Pause when its last 10 days' CPP is above it.

`max_spend_no_purchase` — applies while an ad has **no** purchase at all: it is Pause once it has
spent more than this, both in its first 9 days and over its last 10. It is **optional**, and NULL
is meaningful: the limit then comes from the successful ads' own spend before their first purchase
(`firstPurchaseLimit`), which is how this worked before the column existed. So a blank field is the
old behaviour exactly, and the column was added NULL for every product on 2026-09-12 — nothing
changed until someone typed a number.

Which one is in force shows up in `firstPurchaseLimit.source` (`"threshold"` vs `"benchmark"`), and
`firstPurchaseLimit.derived` always carries what the successful ads alone would have set, so the
panel can show it as the placeholder behind an empty field.

Note that an override applies even to a product with **no** successful ads, where the derived limit
would be null and every unconverted ad would otherwise read Keep.

Seeded on 2026-09-11 from the old 10-day cost thresholds: 280 for every product except educator
program at 700.

`ad_closing_threshold` — the old adset-level thresholds (5-day and 10-day cost and purchases per
product). **The dashboard no longer edits or uses it.** The daily adset task still reads it for the
fallback Advise it stores.

```
product (TEXT), cost_5d_threshold (REAL), purchase_5d_threshold (INTEGER),
cost_10d_threshold (REAL), purchase_10d_threshold (INTEGER), updated_at (TEXT)
```

`benchmark_ads` / `benchmark_ad_daily` / `benchmark_runs` hold the raw data behind the benchmark:
- every ad that ran 11+ days in the last 3 months, **whatever its CPP** (the threshold is applied
  when the data is read, so changing it never needs a re-fetch)
- each ad's days 1–11 of spend and purchases
- one row per monthly refresh

Nothing computed is stored. Full column list:
[scripts/benchmark-refresh/README.md](scripts/benchmark-refresh/README.md).

Products are identified by a keyword match on **campaign name**, not on ad account:
- `trubuddy`, `mpedia`, `gulu`
- `educator`, which maps to the product `educator program`
- `adi-anku` (also `adi anku` / `adi_anku`), which maps to `adi anku`

`lib/cpp-benchmark/src/config.js` holds that list. A campaign matching none or several of them is
unclassified: its ads get no verdict and its adset shows `–`.

The daily adset task has its own copy of the list. That copy lacks `adi-anku`, but since its
Advise is only a fallback now, that no longer affects what the dashboard shows.

## Frontend behaviour, and the fixes baked into it — don't reintroduce these bugs

### 1. Caching (fixed — keep it)

Both `functions/api/snapshots.js` and `functions/api/thresholds.js` set `Cache-Control: no-store` on their responses, **and** both `fetch()` calls in `public/index.html` pass `{ cache: "no-store" }`. All four of those must stay. Without them, refreshing the dashboard can silently serve stale cached data instead of the current D1 state — this exact bug happened here (and previously on the separate Audience Catalog tool) before being fixed. If you touch either file, keep these in place.

### 2. Pinned (sticky) leading columns

The **Advise**, **Ad Account Name** and **Adset Name** columns stay frozen at the left edge while the rest of the table scrolls horizontally. How it works:

- Widths live in three CSS custom properties on `:root` — `--w-advise: 110px`, `--w-account: 190px`, `--w-adset: 280px`.
- The cells carry `.pinned` plus `.pin-1` / `.pin-2` / `.pin-3` classes, added in `renderHead()` and `renderBody()` for the first `PINNED_COUNT = 3` columns. Each class sets `position: sticky` with an explicit `left` offset built from those variables: `0`, `var(--w-advise)`, and `calc(var(--w-advise) + var(--w-account))`.
- **Sticky positioning cannot work with auto-sized columns** — that's why each pinned column has a hard `width` / `min-width` / `max-width`, and why long values are clipped by an inner `.truncate` span (with the full text kept in the cell's `title` for hover) instead of being allowed to widen the column and desynchronise the offsets.
- Pinned cells get opaque backgrounds matching each row state (base, `:nth-child(even)`, `:hover`) plus `z-index` layering — pinned header `3`, pinned body cell `2` — so scrolling content can't show through them.
- Two media queries matter: under 900px the three widths shrink; under 700px the pins are turned off entirely (`position: static`), because three pinned columns would otherwise consume the whole viewport.

If you add, remove or reorder entries in the `COLUMNS` array, you must re-check `PINNED_COUNT`, the `.pin-*` offsets and the widths against the new header labels — then render the page and scroll it to confirm, rather than trusting the CSS by inspection.

### 3. Full-width layout

`.wrap` deliberately has **no** `max-width`; the page runs the full browser width so the results table can show as many columns as fit before it needs to scroll horizontally. The pinned-column behaviour above still handles whatever remains off-screen. Two things exist to stop other elements looking stranded on a wide screen: the stats grid uses `repeat(auto-fit, minmax(150px, 240px))` so the single tile doesn't stretch, and `.thresh-table` is capped at `max-width: 760px`. That cap
only works because the rule also sets `min-width: 0`: the global `table{ min-width:100% }` beats
`max-width` otherwise, and the panel's table used to stretch across the whole page. If you reintroduce a page-level `max-width`, you are undoing this on purpose — make sure that's what you mean.

### 4. Stats row

Only one stat tile is shown: **Adsets tracked** (`#stat-total`). The former "Keep" and "Pause" count tiles were removed deliberately. `renderStats()` writes `#stat-total`, `#total-count` and the per-account counts on the filter buttons.

**The filter is by ad account, not by advice.** The buttons are **All / Tuhin Paul / TruBuddy**, each
with its adset count. The All / Keep / Pause filter was removed on 2026-09-11 at the user's request.
`getFiltered()` matches a button's `data-filter` against the row's `account` exactly, so a new ad
account needs its own button, with the name spelled exactly as `adset_snapshots.ad_account` has it.
Sorting by the Advise column still groups the Pauses together.

### 5. Thresholds panel — one Save for the whole table

The panel ("Thresholds by product") lists every product with **two** inputs from
`benchmark_thresholds`: `.f-maxcpp` (max CPP, required) and `.f-maxspend` (max spend with no
purchase, optional — added 2026-09-12). Next to them is how many of the stored 11+ day ads the CPP
number lets into the benchmark, e.g. "119 of 420 ads that ran 11+ days". The adset-level 5/10-day
inputs were removed on 2026-09-11.

An empty `.f-maxspend` is a real value, not a missing one: it hands the limit back to the benchmark,
and its **placeholder shows the number that takes over** (`auto 520`, or just `auto` when that
product has no successful ads to derive one from). That is why it is wider than the CPP box — the
placeholder has to fit. Don't "fix" an empty field by writing the placeholder into it; that would
freeze a number that is meant to track the benchmark.

The help paragraph needs `max-width` (`.thresholds-panel p.help`). The panel shares the wide,
horizontally pannable container the adsets table uses, so unconstrained prose runs off the side of
the page instead of wrapping.

There is a **single Save button at the bottom of the table** (`#thresh-save-all`)
rather than one button per row. Clicking it:

- reads both input values from every `#thresh-body tr[data-product]` row (an empty `.f-maxspend`
  goes out as `""`, which the API stores as NULL),
- issues one `POST /api/thresholds` per product concurrently (the API only accepts a single product per request),
- disables itself and shows "Saving…" while the requests are in flight, then
- reports **one combined status message** in `#thresh-status`: either `Saved all N products · Advise updated.` (green, auto-clears after 4s) or `Saved X of N · failed: <product> (<reason>), …` (red, and it stays put) naming each product that failed and why.
- after any successful save it clears the cached drill-downs and reloads the adset table, because
  every verdict depends on the thresholds. It then reloads the panel so the counts match the new
  numbers.

Keep the combined-status behaviour if you rework this: a per-row status was the previous design, and it made a partial failure easy to miss.

### 6. Panel visibility (fixed)

`#thresholds-panel` carries the `hidden` attribute in the HTML and is toggled by the "Edit Thresholds" button. The rule `.thresholds-panel{ display:flex; … }` is a normal-priority author rule, so it **outranks** the user-agent's `[hidden]{display:none}` regardless of the attribute being present — the panel therefore rendered open on every page load, ignoring the toggle. Fixed by adding:

```css
.thresholds-panel[hidden]{ display:none; }
```

Any element you style with an explicit `display` *and* toggle via `hidden` needs the same companion rule.

### 7. Column widths, resizing and drag-to-pan

Columns are sized to their **content**, not stretched to fill the page, so as many of them fit
on screen as possible before anything has to scroll. How that works, in `renderHead`/`fitColumns`:

- The table renders once with `table-layout: auto` and `width: max-content`, **with the header
  row hidden**, and JS reads the width each column ended up at. The header is hidden for the
  measurement on purpose: labels like "Avg Cost/Result (Last 10 Days)" are far wider than the
  values under them, and would otherwise force a ~210px column to show a ₹ figure. The labels
  wrap instead (`th button .lbl` is `overflow-wrap: break-word`).
- Each measured width is clamped to that column's `min`/`max` in the `COLUMNS` array. Any space
  left over goes to the column marked `flex: true` (Campaign Name) so the table still fills the
  shell exactly.
- Those numbers are then written onto `<col>` elements and the table switches to
  `table-layout: fixed`. Fixed layout is what makes resizing exact and keeps the pinned columns'
  offsets truthful.
- **Resizing**: every header carries a `.col-resizer` grip on its right edge. Dragging it sets
  that one column's width; double-clicking any grip resets every column to the measured defaults.
  Widths are deliberately **not** persisted — every load starts from the measured defaults.
- **The pinned columns' `left` offsets are recomputed on every width change** (`applyWidths` sets
  `--w-advise` / `--w-account` / `--w-adset` on the table element). If you ever set those widths
  from CSS again instead, resizing a pinned column will tear the frozen columns apart.
- **Drag-to-pan**: pressing anywhere on the table and dragging sideways scrolls it, so a wide
  table can be swiped rather than reaching for the scrollbar. It only engages after ~5px of
  movement that is more horizontal than vertical, so ordinary clicks and vertical page scrolling
  are untouched, and the click that ends a drag is swallowed (`suppressClick`) so panning never
  toggles a drill-down open. Mouse only — touch devices already scroll natively.

### 8. Adset drill-down

Clicking an adset name expands a panel under that row listing **every ad in that adset**: ad name
with its Active/Paused badge, the ad's start date, its 10-day spend, conversions and **CPP** (cost
per purchase — that ad's own spend ÷ its own conversions, shown as `–` when it has none), and then
one column per day showing that day's spend with its conversions underneath. A totals row closes it
out, and its CPP should match the adset row's own `cost_10d` to the paisa.

- Data comes from `GET /api/ads`, fetched on first expand and cached per adset for the session.
- **The panel's columns are laid out by `layoutAdsTable`, not by content.** It starts from a base
  ratio (`ADS_FIXED_W` for the five leading columns, `ADS_DAY_W` per day), then hands the spare room
  out evenly — the same pixel count to every column — so the table fills the panel edge to edge and
  all day columns stay identical to one another. Rounding drift goes to the name column so the day
  columns stay exactly equal. If the base ratio is already wider than the panel the base widths hold
  and the panel scrolls. Re-runs on resize via `syncDetailWidths`.
- Ad status is a coloured dot before the name, not a badge after it: the name cell ellipsises, so a
  trailing badge vanished on exactly the long names you most want to identify.
- Watch out for `tr.detail-row > td` — as a *descendant* selector (`tr.detail-row td`) it outranks
  `.ads-table td` and silently strips `nowrap`/ellipsis from every cell of the nested table, wrapping
  ad names onto two lines. Keep the child combinator.
- **Day columns are trimmed to when the ads actually existed.** If every ad in the adset was created
  four days ago, the panel shows four day columns, not ten with six blanks. The cut is the earliest
  `ad_created_date` across the adset's ads (never earlier than the window start), so a dropped day
  is always one on which no ad existed and therefore always zero — trimming can never hide spend,
  and the 10-day totals still reconcile. When it trims, the header says so.
  In the rare adset whose ads have *different* start dates (1 of 43 at the last check), the columns
  span all of them and the later ad's pre-creation cells render blank (`.day.pre`) rather than `–`,
  so "did not exist yet" never reads as "ran and spent nothing".
- The panel's inner div is `position: sticky; left: 0` and sized to the scroll container, so it
  stays on screen no matter how far right the table is scrolled.
- Expanded rows survive sorting and filtering — `renderBody` re-opens whatever was open.
- **The first column is the ad's own Keep/Pause** ("Advise"), computed by `/api/ads`. Rules:
  [lib/cpp-benchmark/README.md](lib/cpp-benchmark/README.md).
  - **Days 1–9** (pill label `d4`): compared day by day with the successful ads of the same
    product. With a purchase, its cumulative CPP against that day's highest + 10%. Without one,
    its spend against the most any successful ad spent before its first purchase.
  - **Past day 9, or created before the 10-day window** (pill label `10d`): its last 10 days' CPP
    against the product threshold. With no purchase in those days, its spend against the
    first-purchase limit.
  - Hovering the pill spells out the comparison.
  - **Ads already paused in Meta** keep their verdict, shown dimmed, but don't count towards the
    adset.
  - The day grid marks each incubation day: a thin green rule for Keep, an amber tint for Pause.
    That makes the day an ad crossed the line visible.
  - Under the panel header:
    - One line says what the verdicts were measured against: how many successful ads, at which
      threshold, and when the benchmark was refreshed.
    - A second line, "Adset: Pause — 1 of 5 running ads is on Pause", states the roll-up that the
      adset row shows.
- **Ad-level conversions can be a conversion or two short of the adset row.** Meta attributes some
  conversions at adset level without assigning them to a specific ad. At the last backfill this
  affected 2 of 43 adsets (each off by one). The panel says so in-line when the numbers disagree
  rather than hiding it — don't "fix" this by scaling the ad numbers to match.

### 9. Typo

The button reads "Edit Thresholds", not "Edite Thresholds" — someone already fixed this once.

### 10. Adset Advise follows its ads

Since 2026-09-11 the adset row's Advise is **not** the daily task's 5/10-day threshold rule. It is
decided in `/api/snapshots` by the same code the drill-down uses, and there are now **four rules
OR'd together** — the adset is Pause if *any* of them says so:

1. the roll-up from its ads (below),
2. slow first purchase (added 2026-09-11),
3. adset CPP above the adset benchmark (added 2026-09-12),
4. adset spend before its first purchase above the adset benchmark (added 2026-09-12).

3 and 4 are mutually exclusive by construction: 3 needs the adset to have converted, 4 needs it not
to have. 2, 3 and 4 all make the adset's pill **red** (see below).

Two things sit on top of all of them, added 2026-09-12:

- **Early-day immunity.** An adset's own rules don't apply for its first `adsetImmuneDays` (2) days,
  and an ad isn't judged on its first `adImmuneDays` (1) day. See "Immunity" below.
- **The product threshold can overrule rules 3 and 4.** See "Product day thresholds" below.

### Product day thresholds — the rescue

`productDayThresholds` in `lib/cpp-benchmark/src/config.js` (seeded from `DEFAULT_DAY_THRESHOLDS`)
holds a per-product, day-wise CPP schedule. An adset that rules 3 or 4 have flagged is put **back to
Keep** when it is inside its product's threshold. The 3-month benchmark is drawn from history and
can be stricter than the number the business actually runs to; this is how the business number wins.

| day | trubuddy | mpedia / gulu |
|---|---|---|
| 2 | ₹700 | at least 1 purchase |
| 3 | ₹527 | ₹470 |
| 5 | ₹370 | ₹330 |
| 10 | ₹280 | ₹250 |

- **They are checkpoints, not exact days.** The one in force is the **latest checkpoint at or before
  the day**: trubuddy day 4 uses the day-3 number, days 6-9 the day-5 one, day 11+ the day-10 one.
  Below the first checkpoint there is none.
- **adi anku and educator program have no schedule on purpose** — "the old process". Nothing rescues
  them, so the benchmark's word is final.
- **It only ever rescues.** Being *above* the threshold does not pause anything by itself; it just
  lets the benchmark's flag stand. Adding an independent Pause would be a one-line change in
  `judgeAdset`, and was deliberately not made.
- **It does not overrule the ads.** If the adset's own ads are Pause, the roll-up still says Pause —
  the rescue only clears the adset-level flag. So a rescued adset can still read Pause with
  `basis: "ads"`, and `adviseDetail.rescued` is true.
- **The day-2 row is unreachable at adset level** because immunity covers days 1-2. It is kept so
  the schedule matches what was specified, and is ready if the rescue is ever extended to ad level.

### Immunity — the first days don't count

- **Adset: days 1-2.** No adset-level rule (2, 3 or 4) may flag it. Its ads are still judged on their
  own rules, so the row can still be Pause from the roll-up. The hover says so.
- **Ad: day 1.** The day still appears in the grid with its real numbers, as a Keep with reason
  `immune_early_days`. One day of delivery is noise, and an ad paused on it never gets to settle.

Both are `adsetImmuneDays` / `adImmuneDays` in config.js. `public/index.html` mirrors them as
`IMMUNE_ADSET_DAYS` / `IMMUNE_AD_DAYS` for its hover text — **change both** if you retune them.

### CPP when nothing has been bought

`effectiveCpp()` in `lib/cpp-benchmark/src/thresholds.js` treats **spend as the CPP when purchases
are 0**. An ad or adset that has spent ₹900 for nothing is a ₹900 CPP, not "no data". Since
2026-09-12 this applies to **every** CPP comparison, not just the product thresholds:

| where | what an unconverted ad/adset is now measured against |
|---|---|
| `judgeDay` (ad, days 1-9) | the first-purchase spend limit **and** that day's CPP ceiling |
| `judgeWindow` (ad, past day 9) | the first-purchase spend limit **and** the product's `max_cpp` |
| `adsetCpp` (adset) | that day's adset CPP ceiling |
| `judgeProductThreshold` | the product's day-wise threshold |

**They are OR'd, not swapped.** The first-purchase spend limits still exist and still fire; the CPP
comparison is an additional way to be paused, so an unconverted ad now faces two lines where it used
to face one. When both fire, the **spend limit is the reason reported** — it is the more specific
"never converted" signal.

Once there is a purchase the spend limits stand down for good and only CPP counts, as before:
judging a converted ad on its pre-purchase spend would leave it on Pause forever however good its
CPP became.

This makes verdicts materially stricter for unconverted ads. The lines are generous (they are `max`
of the cohort), so the practical effect is on ads whose spend is between the day's CPP ceiling and
the first-purchase limit — for trubuddy on 2026-09-12 that was days 6, 8 and 9, whose ad-level
ceilings (₹442, ₹403, ₹352) sit below the ₹520 first-purchase limit. 113 of the live ads had zero
purchases, averaging ₹101 spent, so most stayed well inside both.

**On the page:** a CPP cell that is really just spend is shown in amber with a dotted underline and
a hover saying so (`td.cpp-no-purchase`), in the ads table, the drill-down footer and the adset
row's two cost columns. Note the adset row's `cost_5d` / `cost_10d` already came this way — the
daily task has always stored the spend there when conversions are 0, so no pipeline change was
needed, only the visual cue.

The roll-up itself:

- **Pause** if at least one **running** ad is Pause.
- **Keep** if every running ad with a verdict is Keep.
- **`–`** when the campaign doesn't match a product, there's no ad data for the adset, or no
  running ad has a verdict.

**Two colours of Pause on the adset row** (added 2026-09-12). A Pause decided by an adset-level rule
— rules 2, 3 and 4, i.e. `basis` is `adset`, `adset_cpp` or `adset_spend` — is **red** (`.pill.pause.by-adset`, the
`--bad` palette). A Pause that is just the roll-up of its ads stays **amber** (`--warn`). The point
is to tell at a glance which adsets are being flagged as a whole rather than for containing a bad
ad. `isAdsetBasis()` in `public/index.html` is the single check; extend it if another adset-level
rule is ever added. **Ad pills in the drill-down are always amber**, including ads flagged by the
slow-first-purchase cascade — the red is an adset-row signal only.

Since 2026-09-12 the **whole Advise cell** is washed red too (`td.pin-1.by-adset`), with a solid
4px bar down its leading edge and the pill flipped to solid `--bad` on `--bad-ink`. The pinned
column's own backgrounds (even rows, hover, expanded) are more specific than a single class, so
**each state needs its own override rule** — that is why there are four of them rather than one.

An ad counts as running unless Meta says it is paused, deleted or archived. Ads you've already
switched off don't make the adset read Pause.

This exists because the two used to disagree: adsets were advised Pause by the adset rule while
every ad inside was on Keep, and the reverse. Hovering the adset's pill lists the ads that made it
Pause. If the ad-level data can't be loaded, the page shows a warning and falls back to the daily
task's stored Advise.

**Slow first purchase (added 2026-09-11) overrides the roll-up.** If the adset took more days to
make its first purchase than the slowest successful ad of its product took, the adset is Pause and
**every ad under it is Pause too**, whatever their own verdicts.
- **The limit** (`firstPurchaseDayLimit`) is the latest day on which any successful ad made its
  first purchase. Day 1 is an ad's first day with spend, and the same successful-ad set and
  threshold are used as everywhere else. On 2026-09-11 the limits were: TruBuddy and Mpedia 10,
  educator program 6, Gulu 3, Adi Anku 1. Adi Anku's comes from one ad.
- **The adset's day 1** is the first day any of its ads spent. Every ad's purchases count,
  including ads already paused in Meta, because they are part of the adset's history.
- **When it's Pause:** the adset's first purchase came after the limit day, or it has already run
  more days than the limit without one. A first purchase exactly on the limit day is in time.
- **Only checked when every ad in the adset started inside the 10-day window.** For an older adset
  the first purchase may be older than `ad_snapshots` shows, and guessing would pause good adsets.
  The hover text says "not checked" for those.
- **One function decides both.** `judgeAdset` in `lib/dashboard/advise.js` is called by both
  `/api/snapshots` and `/api/ads`, so the adset row and the drill-down can't disagree.
- **On the page:** the adset's hover text states the first purchase against the limit.
- **In the drill-down:**
  - An amber line under the header states the same thing.
  - Each ad's pill is labelled `adset`, and its hover text gives the adset reason followed by the
    ad's own verdict (kept in `advise.own`).
  - The day grid still shows each ad's own day-by-day verdicts.

**Adset CPP against past adsets (added 2026-09-12).** The whole adset's cumulative CPP is compared,
day by day, with what past adsets of the same product had on the same day. Above that day's line and
the adset is Pause — even when every one of its ads passes on its own. An adset can be built of
individually-acceptable ads and still cost more per purchase than any adset that ever worked.

- **The benchmark** (`buildAdsetBenchmarks`) is built the same way as the ad-level one and from the
  same stored rows, just grouped by `ad_account|campaign_name|adset_name` instead of by ad: the
  highest cumulative CPP any qualifying past adset had on that day, plus `cppMargin` (10%). The
  **same `max_cpp` threshold picks the adset cohort**, so a past adset that was already too
  expensive at day 10 can't raise the line for everyone else.
- **It does NOT cascade to the ads.** Unlike the slow-first-purchase rule, the adset reads Pause
  while its ads keep their own verdicts, so the ad column still says which ones are worth keeping.
  `basis` is `adset_cpp`, and the hover spells out both halves.
- **Only days 1–9**, and only once the adset has a purchase — before that there is no CPP and the
  first-purchase rules already cover it. Guarded like the first-purchase rule: every ad must have
  started inside the 10-day window, or day alignment would be reading the wrong day 1.
- **Known bias, read this before trusting a number.** `benchmark_ads` stores only ads that ran 11+
  days, so a past adset is rebuilt from its long-running ads alone — its short-lived ads are not
  stored and are missing from the sum. The live adset it is compared against uses *all* of its ads.
  That makes the historical line a little cheaper than those adsets really were, so **the rule leans
  towards Pause**. Fixing it properly means storing every ad of a qualifying adset in the monthly
  refresh; it is not a change on the dashboard side.
- **Calibration on 2026-09-12**, the day it shipped: trubuddy's cohort was 52 adsets and the Pause
  lines ran ₹410.93 (day 1), ₹682.55 (day 2), ₹412.69 (day 3) … ₹348.41 (day 9). The day-2 spike is
  a small-sample artefact of using `max` as the statistic — the ad-level benchmark has the same
  property. Of the 27 live adsets eligible that day, **13 were flagged** by this rule. If that hit
  rate looks too high, the dials are `ceilingStatistic` (try a percentile) and `cppMargin`, both in
  `lib/cpp-benchmark/src/config.js` — don't special-case it in the dashboard.

**Adset spend before its first purchase (added 2026-09-12).** The same question as the CPP rule, for
an adset that hasn't converted at all so there is no CPP to ask it with. The adset's total spend so
far is compared with what past adsets of the product spent before *their* first purchase; above that
and the adset is Pause.

- **The limit** is `firstPurchaseSpendLimit` on the adset benchmark: the most any cohort adset spent
  before converting (`spendBeforeFirstPurchase` over days 1–9), **plus `cppMargin` (10%)**. Note the
  ad-level `firstPurchaseLimit` deliberately has **no** margin; this one does, because an adset pools
  several ads and its pre-purchase spend is lumpier than any single ad's.
- **Only while the adset has no purchase at all.** Once it converts, its CPP is the fair question and
  the CPP rule asks it. Judging a converted adset on its pre-purchase spend would leave it on Pause
  forever however good its CPP became — the same reason the ad-level rule stands down after the
  first purchase.
- **Only days 1–9.** An adset older than that with still no purchase is already caught by the
  first-purchase *day* limit (rule 2). Same window guard as rules 2 and 3.
- **In practice rule 2 often fires first** for an adset with no purchases, so `basis` is `adset`
  rather than `adset_spend` — both are red, so the row looks the same either way. `adset_spend` is
  the reported basis when the day limit is generous relative to the spend, which is the gap this
  rule exists to cover.
- **Calibration on 2026-09-12:** the Pause lines were trubuddy ₹1,070.34 (from 56 adsets, ceiling
  ₹973.04), educator program ₹972.50, gulu ₹843.35, mpedia ₹783.63. Adi Anku had no cohort. **No
  live adset tripped it that day** — the three with zero conversions were all around ₹700, under the
  line. It is a backstop for an adset burning past ~₹1,000 with nothing to show, not a rule that
  fires often.

### 11. Campaign copy button

Every campaign name in the main table has a copy button right after it (`.copy-btn`). A click copies
that name and briefly shows a green tick, or a red state if the browser refused.
- It uses `navigator.clipboard.writeText`, with a hidden-textarea `execCommand("copy")` fallback.
  The fallback kicks in if `writeText` hasn't settled within 800ms, which happens when a clipboard
  permission prompt is pending.
- The name is a `flex: 0 1 auto` span. That keeps the button beside the text instead of at the far
  edge of the wide Campaign column, and the name still ellipsises when the column is narrow.
- Clicks are handled in the same delegated `body` click listener as the drill-down toggle, so they
  never open a row. The click that ends a drag-to-pan is still swallowed.

### 12. Favicon

`public/favicon.svg` is linked from `index.html` with `<link rel="icon">`. It shows a cream play
triangle (Keep) and amber pause bars (Pause) on the dashboard's green, and `theme-color` is set to
the same green. It's a plain file, so Pages serves it at `/favicon.svg`.

## Important operating constraint: a cloud session (probably) cannot push to GitHub itself

If you are a cloud-sandboxed Claude session (rather than a local CLI running on the human's own machine), `git push` will very likely fail with:

```
remote: access denied by the git proxy: <repo> is not in this session's authorized repository set,
so the proxy will not inject a credential for it. To fix, add the repository to the session's sources.
```

This is an **organization-level network policy** on the sandbox's outbound git access — it is separate from any GitHub token's permissions, and a valid, correctly-scoped Personal Access Token does not get around it. Cloning and reading the repo work fine even when the block is active; only pushing is affected, and it has been confirmed to affect every repo tried under this account so far, not just this one.

If you hit it: don't keep retrying, and don't try to route around it via some other network path. Make and verify your change in the sandbox, then hand the finished file(s) to the human along with the exact `git add` / `git commit` / `git push` commands to run from their own machine. That always works.

If you're running as a local CLI directly on the human's machine, this constraint doesn't apply — push normally. **Pushing to `main` publishes the live site**, because the Pages project auto-deploys from this repo.

## Repo structure

```
ads-monitor-project/
├── public/
│   ├── index.html          ← entire frontend: HTML, CSS, JS inline
│   └── favicon.svg         ← the tab icon
├── functions/
│   └── api/
│       ├── snapshots.js    ← GET: adset rows, Advise rolled up from their ads
│       ├── thresholds.js   ← GET/POST: per-product CPP thresholds (benchmark_thresholds)
│       └── ads.js          ← GET: one adset's ads with their own Keep/Pause (drill-down)
├── lib/
│   ├── dashboard/advise.js ← D1 reads + judging, shared by the three functions
│   └── cpp-benchmark/      ← pure Keep/Pause calculation, tested
│       ├── src/            ← index.js is the public API; config.js holds every tunable number
│       ├── test/           ← node:test suite — `npm test` from lib/cpp-benchmark/
│       └── README.md       ← the rules, the output, the numbers from the first backfill
├── scripts/
│   └── benchmark-refresh/  ← what the monthly benchmark task runs (never deployed)
├── wrangler.toml           ← name, pages_build_output_dir, D1 binding
└── README.md               ← this file
```

`.wrangler/` is local wrangler state and should never be committed.

`wrangler.toml` must keep its `[[d1_databases]]` block (`binding = "DB"`, `database_name = "meta-ads-report"`, `database_id = "49a148d0-1f38-4ebb-9885-6c5ee40f995e"`). If a Git-connected deploy ever loses the D1 binding (check Settings → Functions → D1 database bindings in the Cloudflare dashboard after any redeploy), re-add it there manually — a Git-connected project doesn't always inherit bindings automatically from `wrangler.toml`.

## History (brief)

- Originally prototyped as a standalone Cloudflare Worker (`meta-ads-dashboard`), then migrated to a Cloudflare Pages Functions app once a D1-backed multi-tool architecture was decided on.
- Briefly deployed as a subpath of a combined hub+dashboard Pages project — this caused a separate tool (Audience Catalog) to lose its D1 binding when that combined project was redeployed. Fixed by giving this project its own standalone Cloudflare Pages project, its own repo and its own `wrangler.toml`.
- Renamed from "keep-or-pause" to "ads-monitor" for naming-convention consistency. Watch out: an earlier deploy accidentally created a Cloudflare project named `meta-ads-ads-monitor` (duplicated "ads") — the correct name is `meta-ads-monitor`.
- Migrated from manual `wrangler pages deploy` to Git-connected Cloudflare Pages auto-deploy.
- Fixed the D1 undercount bug and the caching bug; added sticky columns; fixed the "Edite Thresholds" typo.
- Removed the Keep/Pause stat tiles, replaced the per-row threshold Save buttons with a single Save, removed the page's `max-width`, and fixed the always-open thresholds panel.
- Added content-sized, resizable columns and drag-to-pan, and the ad-level adset drill-down
  (`ad_snapshots` + `/api/ads`), backfilled once from the Meta API for 2026-09-10, then put on a
  daily footing with its own scheduled task at 03:30 UTC.
- Added `lib/cpp-benchmark/` as a standalone calculation module. It was then reworked into the
  ad-level Keep/Pause:
  - The `benchmark_*` tables were added and backfilled with 3 months of successful ads.
  - A monthly refresh task was added.
  - The drill-down's Advise column was added.
- Replaced the adset-level thresholds with one CPP threshold per product (`benchmark_thresholds`).
  It filters which 11+ day ads count as successful (day-10 CPP) and judges ads past day 9 on their
  last 10 days. The adset Advise is now rolled up from its running ads.
- Added the slow-first-purchase rule, which puts the adset and all its ads on Pause. The
  All / Keep / Pause filter was replaced by an ad-account filter. Added the campaign copy buttons
  and a favicon.

## Open items

- Confirm the D1 binding survived the most recent Git-connected redeploy (Cloudflare dashboard → Settings → Functions).
- If the daily D1 task's adset count ever looks wrong again, cross-check against that day's Google Sheet report before assuming the dashboard is broken — that Sheet is the ground truth.
- **The benchmark uses the highest value** among the successful ads that pass the threshold.
  With the ₹280 filter the lines are much tighter than before. On 2026-09-11 TruBuddy had 119 of
  its 420 11+ day ads passing. If they still look loose, the 90th percentile is a one-line switch in
  `lib/cpp-benchmark/src/config.js`.
- **Thin cohorts:** Adi Anku's benchmark is one ad. Gulu's is 9 and educator program's 10. Their
  verdicts firm up as the monthly refresh adds ads. This matters most for the slow-first-purchase
  rule. Adi Anku's one ad bought on day 1, so any Adi Anku adset without a purchase on its first
  day is Pause.
- Watch the first scheduled monthly refresh (2026-10-01). Check its run log and its
  `benchmark_runs` row.
- **The daily adset task's own Advise is now only a fallback.** Two follow-ups could simplify it,
  but neither is needed for the dashboard to be correct:
  - Its Advise step, and its product keyword list (which lacks `adi-anku`), could be removed from
    its prompt.
  - `ad_closing_threshold` could be retired with it.

  That task's prompt can't be edited through the routines API: an update replaces the routine's
  whole session configuration, and this task keeps settings and an enrollment token there. Edit it
  in the routine editor (https://claude.ai/code/routines/trig_019hg5R68FYS1PgdFckLGZEk).
