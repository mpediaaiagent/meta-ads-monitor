// The D1 side of the Keep/Pause: reads the raw rows and hands them to lib/cpp-benchmark.
// Shared by /api/snapshots (adset Advise), /api/ads (the drill-down) and /api/thresholds (counts),
// so all three always agree. judgeAdset is the entry point for an adset and its ads.

import {
  BASIS,
  REASON,
  STATUS,
  VERDICT,
  adsetFirstPurchase,
  buildBenchmarks,
  classifyProduct,
  evaluateAd,
  judgeWindow,
  resolveConfig,
  rollUpAdset,
} from "../cpp-benchmark/src/index.js";

/**
 * Everything needed to judge ads, read fresh on every call: the per-product thresholds (edited on
 * the dashboard), the benchmarks built from the stored successful ads under those thresholds, and
 * the latest monthly refresh. Nothing is cached, so a saved threshold applies on the next request.
 */
export async function loadAdviseContext(db) {
  const probe = resolveConfig();
  const [thresholdsRes, adsRes, dailyRes, runRes] = await db.batch([
    db.prepare("SELECT product, max_cpp FROM benchmark_thresholds"),
    db.prepare("SELECT ad_id, campaign_name FROM benchmark_ads"),
    // days 1..successCppDay of every stored ad: all a benchmark or its threshold check can use.
    // Stored rows start on each ad's first day with spend, so MIN(date) is its day 1.
    db
      .prepare(
        `SELECT d.ad_id, d.date, d.spend, d.purchases
         FROM benchmark_ad_daily d
         JOIN (SELECT ad_id, date(MIN(date), '+' || ? || ' days') AS last_day FROM benchmark_ad_daily GROUP BY ad_id) f
           ON f.ad_id = d.ad_id
         WHERE d.date <= f.last_day`
      )
      .bind(probe.successCppDay - 1),
    db.prepare("SELECT run_date, window_since, window_until, created_to FROM benchmark_runs ORDER BY run_date DESC LIMIT 1"),
  ]);

  const maxCppByProduct = {};
  for (const t of thresholdsRes.results) maxCppByProduct[String(t.product).trim().toLowerCase()] = Number(t.max_cpp);
  const cfg = resolveConfig({ maxCppByProduct });

  const campaignOf = new Map(adsRes.results.map((a) => [a.ad_id, a.campaign_name]));
  const byAd = new Map();
  for (const r of dailyRes.results) {
    if (!byAd.has(r.ad_id)) byAd.set(r.ad_id, []);
    byAd.get(r.ad_id).push({ date: r.date, spend: r.spend, purchases: r.purchases });
  }
  const built = buildBenchmarks(
    [...byAd].map(([adId, daily]) => ({ adId, campaignName: campaignOf.get(adId) ?? "", daily })),
    cfg
  );

  return { cfg, products: built.products, run: runRes.results[0] || null };
}

/** What the drill-down legend and the thresholds panel show about one product's benchmark. */
export function benchmarkSummary(ctx, product) {
  const b = ctx.products[product];
  return {
    available: true,
    product,
    maxCpp: b.maxCpp,
    candidates: b.candidates,
    cohortSize: b.cohortSize,
    refreshedOn: ctx.run ? ctx.run.run_date : null,
    windowSince: ctx.run ? ctx.run.window_since : null,
    cppMargin: ctx.cfg.cppMargin,
    incubationMaxDay: ctx.cfg.incubationMaxDay,
    successMinDays: ctx.cfg.successMinDays,
    successCppDay: ctx.cfg.successCppDay,
    firstPurchaseLimit: b.firstPurchaseLimit,
    firstPurchaseDayLimit: b.firstPurchaseDayLimit,
    days: b.days,
  };
}

/**
 * One ad's Keep/Pause from its ad_snapshots row (the 10-day window ending yesterday).
 * - Days 1–9: judged day by day against the benchmark (basis "incubation").
 * - Past day 9, or created before the window (so certainly older than 9 days): judged on its
 *   window totals against the product threshold (basis "window"). Its incubation days, when they
 *   fall inside the window, are still returned for the day grid.
 *
 * @param {{started: string|null, spend10: number, conv10: number, daily: {d: string, s: number, c: number}[]}} ad
 * @param {string[]} dates  the window's dates, oldest first
 */
export function adviseForAd(ad, dates, ctx, product) {
  if (!dates.length || !product) return null;
  const benchmark = ctx.products[product];
  const maxCpp = ctx.cfg.maxCppByProduct?.[product] ?? null;
  const windowVerdict = () => judgeWindow({ spend: ad.spend10, purchases: ad.conv10 }, benchmark, maxCpp);

  if (ad.started && ad.started < dates[0]) {
    const w = windowVerdict();
    return shape({ status: STATUS.PAST_INCUBATION, basis: BASIS.WINDOW, startedBeforeWindow: true, verdict: w.verdict, reason: w.reason, window: w });
  }

  const daily = (ad.daily || []).map((p) => ({ date: p.d, spend: Number(p.s) || 0, purchases: Number(p.c) || 0 }));
  const ev = evaluateAd(daily, benchmark, { through: dates[dates.length - 1] });
  if (ev.status === STATUS.INCUBATION) return shape({ ...ev, basis: BASIS.INCUBATION });
  if (ev.status === STATUS.PAST_INCUBATION) {
    const w = windowVerdict();
    return shape({ ...ev, basis: BASIS.WINDOW, verdict: w.verdict, reason: w.reason, window: w });
  }
  return shape(ev); // not started: no verdict
}

/**
 * Every ad's Keep/Pause and the adset's Advise, for one adset. The one place both are decided,
 * so /api/snapshots and /api/ads always agree. Sets `advise` on every ad and returns the adset's.
 *
 * 1. Each ad on its own rules (adviseForAd).
 * 2. The adset's first purchase against the slowest successful ad (adsetFirstPurchase). When it
 *    took longer, the adset and every ad under it are Pause, whatever their own verdicts, which
 *    are kept in `own`. Checked only when every ad started inside the 10-day window: for an older
 *    adset the first purchase may predate the data, and guessing would pause good adsets.
 * 3. Otherwise the roll-up: Pause if any running ad is Pause.
 *
 * @param {{name: string, status: string, started: string|null, spend10: number, conv10: number,
 *   daily: {d: string, s: number, c: number}[]}[]} ads
 * @param {string[]} dates  the window's dates, oldest first
 */
export function judgeAdset(ads, dates, ctx, product) {
  for (const ad of ads) ad.advise = adviseForAd(ad, dates, ctx, product);
  const roll = rollUpAdset(ads.map((a) => ({ verdict: a.advise ? a.advise.verdict : null, status: a.status })));
  const pauseAds = roll.pauseIndexes.map((i) => ({
    name: ads[i].name,
    basis: ads[i].advise.basis,
    ageDays: ads[i].advise.ageDays,
    reason: ads[i].advise.reason,
  }));

  const firstPurchase = firstPurchaseCheck(ads, dates, ctx, product);
  const slow = firstPurchase.checked && firstPurchase.verdict === VERDICT.PAUSE;
  if (slow) {
    for (const ad of ads) ad.advise = flaggedByAdset(ad.advise);
  }

  return {
    verdict: slow ? VERDICT.PAUSE : roll.verdict,
    // what decided the verdict: the adset's first purchase, or its ads' own verdicts
    basis: slow ? BASIS.ADSET : "ads",
    counted: roll.counted,
    ignoredPaused: roll.ignoredPaused,
    pauseAds, // on their own rules, before any adset flag
    firstPurchase,
  };
}

/** The adset's first purchase against the slowest successful ad, when the window shows its whole life. */
function firstPurchaseCheck(ads, dates, ctx, product) {
  if (!dates.length || !product) return { checked: false, notChecked: "no_data" };
  // Every ad started inside the window, so its first day with spend (and first purchase) is in the data.
  if (!ads.every((a) => a.started && a.started >= dates[0])) return { checked: false, notChecked: "started_before_window" };
  const series = ads.map((a) => ({
    daily: (a.daily || []).map((p) => ({ date: p.d, spend: Number(p.s) || 0, purchases: Number(p.c) || 0 })),
  }));
  return { checked: true, notChecked: null, ...adsetFirstPurchase(series, ctx.products[product], { through: dates[dates.length - 1] }) };
}

/** An ad put on Pause by its adset's slow first purchase; its own verdict stays readable in `own`. */
function flaggedByAdset(a) {
  if (!a) return a;
  return shape({
    ...a,
    basis: BASIS.ADSET,
    verdict: VERDICT.PAUSE,
    reason: REASON.ADSET_FIRST_PURCHASE_TOO_SLOW,
    own: { basis: a.basis, verdict: a.verdict, reason: a.reason },
  });
}

// fixed key order, every key present
function shape(a) {
  return {
    status: a.status,
    basis: a.basis ?? null,
    ageDays: a.ageDays ?? null,
    firstSpendDate: a.firstSpendDate ?? null,
    startedBeforeWindow: Boolean(a.startedBeforeWindow),
    verdict: a.verdict ?? null,
    reason: a.reason ?? null,
    window: a.window ?? null,
    days: a.days ?? [],
    /** the ad's own verdict when its adset overrode it (basis "adset"); null otherwise */
    own: a.own ?? null,
  };
}

export { classifyProduct };
