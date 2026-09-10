# Ads Monitor (dashboard title: "Keep or Pause")

**Read this entire doc before touching anything.** It's written so a Claude Code session with zero memory of building this can pick it up and keep going.

## What this is

A live dashboard showing a Keep/Pause recommendation for every active Meta (Facebook) adset across two ad accounts — **Tuhin Paul** (`807109673203041`) and **TruBuddy** (`949249031427990`) — based on 5-day and 10-day average cost-per-result and conversion (purchase) counts measured against per-product thresholds. The thresholds are editable directly on the dashboard.

Live at: **https://meta-ads-monitor.pages.dev/**

This is one of several independent tools linked from the hub page at https://meta-ads-tools.pages.dev/ — see that repo's own README (`mpediaaiagent/meta-ads-tools`) for the overall multi-tool architecture and why every tool lives in its own separate Cloudflare Pages project. **Do not merge this project with any other tool's project or repo.**

## Architecture

- **Cloudflare Pages** project (`meta-ads-monitor`), Git-connected to this repo for auto-deploy — pushing to `main` triggers a build and publish automatically. No manual `wrangler pages deploy` should be needed once that connection is confirmed live (check Settings → Build & deployments in the Cloudflare dashboard if unsure).
- **Cloudflare D1** database `meta-ads-report` (database_id `49a148d0-1f38-4ebb-9885-6c5ee40f995e`), bound as `DB` in `wrangler.toml`. This is the *only* backend — no other database, and no external API calls at request time.
- **Pages Functions** in `functions/api/`:
  - `snapshots.js` — `GET` returns all rows from `adset_snapshots` for `team = 'marketing'`, ordered by account then 10-day cost descending.
  - `thresholds.js` — `GET` returns all rows from `ad_closing_threshold`; `POST` updates **one** product's four threshold values (the dashboard's single Save button fans out one request per product — see below).
  - `ads.js` — `GET /api/ads?account=&adset=&campaign=` returns every ad in one adset with its day-by-day spend and conversions, for the adset drill-down. `campaign` is optional but should always be sent: Meta reuses adset names across campaigns.
- **Frontend**: `public/index.html`, a single self-contained file (inline CSS + JS, IBM Plex Mono / Manrope from Google Fonts, no build step, no other dependencies).

There is no test suite and no build step. To verify a frontend change, render the page and interact with it — do not just eyeball the CSS. The quickest loop is to copy `public/index.html` somewhere temporary, stub `window.fetch` with sample `snapshots` / `thresholds` / `ads` responses, and serve that directory over plain HTTP (e.g. `npx http-server`); that exercises layout, sticky columns, column resizing, drag-to-pan, the drill-down, the panel toggle and the save flow without needing D1.

## Data pipeline — how the D1 table actually gets populated

This dashboard does **not** pull from Meta's API directly. A separate scheduled task called **"Daily Meta Ads Report — Direct to D1"** (cron `30 2 * * *`, trigger id `trig_019hg5R68FYS1PgdFckLGZEk` as of this writing) runs once a day, wipes `adset_snapshots` for `team = 'marketing'`, and re-inserts a fresh snapshot for every currently-active adset across both accounts. That task's full prompt lives in the scheduled task itself (use `list_triggers` / `update_trigger` on the Claude Code Remote MCP to read or edit it) — it is long and detailed; read it before assuming you know how a value is computed.

A second, older, parallel task called **"Daily Meta Ads Report"** builds the same data as a Google Sheet instead of writing to D1. It is intentionally left alone and untouched by the D1 task. **That Sheet is the trusted cross-check** — if the dashboard's numbers ever look wrong (missing adsets, wrong counts), compare against that day's Sheet before assuming the dashboard's D1 data is correct.

### The ad-level table is NOT yet refreshed by the daily task — read this first

`adset_snapshots` is rewritten every night by the scheduled task. **`ad_snapshots` is not.** It was
backfilled once, by hand, for `report_date` 2026-09-10 (210 ads across all 43 adsets) when the
drill-down was built. Until the daily task is extended, the drill-down keeps showing that snapshot
while the adset rows above it move on — so the first thing to check if the ad numbers look stale is
`SELECT DISTINCT report_date FROM ad_snapshots`.

Extending the daily task is the fix. What that task has to do, with the details that cost time to
work out the first time:

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

`ad_closing_threshold` — one row per product, user-editable from the dashboard:

```
product (TEXT), cost_5d_threshold (REAL), purchase_5d_threshold (INTEGER),
cost_10d_threshold (REAL), purchase_10d_threshold (INTEGER), updated_at (TEXT)
```

Products are identified by a keyword match on **campaign name** (not on ad account): `trubuddy`, `mpedia`, `gulu`, `educator` (which maps to the product `educator program`). A campaign matching none or several of these keywords defaults to Advise = "Keep" and is flagged as unclassified in the daily task's summary.

An adset younger than 5 days is never flagged Pause regardless of its numbers. For eligible adsets (age >= 5), Advise = Pause if EITHER the 5-day window OR the 10-day window has cost-per-result above threshold AND conversions below threshold.

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

`.wrap` deliberately has **no** `max-width`; the page runs the full browser width so the results table can show as many columns as fit before it needs to scroll horizontally. The pinned-column behaviour above still handles whatever remains off-screen. Two things exist to stop other elements looking stranded on a wide screen: the stats grid uses `repeat(auto-fit, minmax(150px, 240px))` so the single tile doesn't stretch, and `.thresh-table` is capped at `max-width: 900px`. If you reintroduce a page-level `max-width`, you are undoing this on purpose — make sure that's what you mean.

### 4. Stats row

Only one stat tile is shown: **Adsets tracked** (`#stat-total`). The former "Keep" and "Pause" count tiles were removed deliberately — those counts remain reachable through the All / Keep / Pause filter buttons and the "N of M adsets shown" counter, so the tiles were redundant. `renderStats()` therefore only writes `#stat-total` and `#total-count`.

### 5. Thresholds panel — one Save for the whole table

The panel lists every product with four numeric inputs, and has a **single Save button at the bottom of the table** (`#thresh-save-all`) rather than one button per row. Clicking it:

- reads the current input values from every `#thresh-body tr[data-product]` row,
- issues one `POST /api/thresholds` per product concurrently (the API only accepts a single product per request),
- disables itself and shows "Saving…" while the requests are in flight, then
- reports **one combined status message** in `#thresh-status`: either `Saved all N products.` (green, auto-clears after 4s) or `Saved X of N · failed: <product> (<reason>), …` (red, and it stays put) naming each product that failed and why.

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
with its Active/Paused badge, the ad's start date, its 10-day spend and conversions, and then one
column per day showing that day's spend with its conversions underneath. A totals row closes it out.

- Data comes from `GET /api/ads`, fetched on first expand and cached per adset for the session.
- The panel's inner div is `position: sticky; left: 0` and sized to the scroll container, so it
  stays on screen no matter how far right the table is scrolled.
- Expanded rows survive sorting and filtering — `renderBody` re-opens whatever was open.
- **Ad-level conversions can be a conversion or two short of the adset row.** Meta attributes some
  conversions at adset level without assigning them to a specific ad. At the last backfill this
  affected 2 of 43 adsets (each off by one). The panel says so in-line when the numbers disagree
  rather than hiding it — don't "fix" this by scaling the ad numbers to match.

### 9. Typo

The button reads "Edit Thresholds", not "Edite Thresholds" — someone already fixed this once.

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
│   └── index.html          ← entire frontend: HTML, CSS, JS inline
├── functions/
│   └── api/
│       ├── snapshots.js    ← GET: reads adset_snapshots
│       ├── thresholds.js   ← GET/POST: reads/updates ad_closing_threshold
│       └── ads.js          ← GET: reads ad_snapshots for one adset (drill-down)
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
  (`ad_snapshots` + `/api/ads`), backfilled once from the Meta API for 2026-09-10.

## Open items

- **Extend the daily task to refresh `ad_snapshots`** — see the section above. Until then the
  drill-down serves the 2026-09-10 backfill regardless of what the adset rows say.
- Confirm the D1 binding survived the most recent Git-connected redeploy (Cloudflare dashboard → Settings → Functions).
- If the daily D1 task's adset count ever looks wrong again, cross-check against that day's Google Sheet report before assuming the dashboard is broken — that Sheet is the ground truth.
