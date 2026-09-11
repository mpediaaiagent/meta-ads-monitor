# Ads Monitor (dashboard title: "Keep or Pause")

**Read this entire doc before touching anything.** It's written so a Claude Code session with zero memory of building this can pick it up and keep going.

## What this is

A live dashboard showing a Keep/Pause recommendation for every active Meta (Facebook) adset across two ad accounts: **Tuhin Paul** (`807109673203041`) and **TruBuddy** (`949249031427990`).

**Every verdict starts at the ad.** Clicking an adset opens its ads, and each ad gets its own
Keep/Pause:
- **Ads in their first 9 days** are compared, day by day, with the same product's successful ads
  from the last 3 months. That compares their cumulative CPP or, before a first purchase, their
  spend.
- **Older ads** are compared on their last 10 days' CPP against the product's threshold.

The adset's Advise then follows its ads: **Pause if at least one running ad is Pause, Keep only if
they all are.** One rule overrides that: **an adset whose first purchase takes more days than the
slowest successful ad took is Pause, and so is every ad under it** (see section 10). The one number
per product that drives all of this (a CPP threshold) is editable on the dashboard.

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
  - `thresholds.js` — `GET` returns the per-product CPP thresholds from `benchmark_thresholds`, each with how many stored 11+ day ads it lets into the benchmark. `POST` updates **one** product's `max_cpp` (the dashboard's single Save button fans out one request per product — see below).
  - `ads.js` — `GET /api/ads?account=&adset=&campaign=` returns every ad in one adset with its day-by-day spend and conversions, for the adset drill-down.
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

`benchmark_thresholds` — one row per product, **edited from the dashboard's "Edit Thresholds" panel**:

```
product (TEXT PK, lower-case: 'trubuddy', 'mpedia', 'gulu', 'educator program', 'adi anku'),
max_cpp (REAL), updated_at (TEXT)
```

`max_cpp` is used in two ways, and both read it on every request, so a save applies at once:
- **Benchmark filter:** an 11+ day ad counts as successful only if its cumulative CPP at day 10 is
  at or under it.
- **Older ads:** an ad past day 9 is Pause when its last 10 days' CPP is above it.

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

The panel ("CPP threshold by product") lists every product with **one** input, its max CPP from
`benchmark_thresholds`. Next to it is how many of the stored 11+ day ads that number lets into the
benchmark, e.g. "119 of 420 ads that ran 11+ days". The adset-level 5/10-day inputs were removed on
2026-09-11. There is a **single Save button at the bottom of the table** (`#thresh-save-all`)
rather than one button per row. Clicking it:

- reads the current input values from every `#thresh-body tr[data-product]` row,
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
rolled up from the adset's ads in `/api/snapshots`, using the same code the drill-down uses:

- **Pause** if at least one **running** ad is Pause.
- **Keep** if every running ad with a verdict is Keep.
- **`–`** when the campaign doesn't match a product, there's no ad data for the adset, or no
  running ad has a verdict.

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
