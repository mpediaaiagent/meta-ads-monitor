// The D1 side of the Keep/Pause: reads the raw rows and hands them to lib/cpp-benchmark.
// Shared by /api/snapshots (adset Advise), /api/ads (the drill-down) and /api/thresholds (counts),
// so all three always agree.

import {
  BASIS,
  STATUS,
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

/** The adset's Advise from its ads' advises: Pause if any running ad is Pause. */
export function adviseForAdset(ads) {
  const roll = rollUpAdset(ads.map((a) => ({ verdict: a.advise ? a.advise.verdict : null, status: a.status })));
  return {
    verdict: roll.verdict,
    counted: roll.counted,
    ignoredPaused: roll.ignoredPaused,
    pauseAds: roll.pauseIndexes.map((i) => ({
      name: ads[i].name,
      basis: ads[i].advise.basis,
      ageDays: ads[i].advise.ageDays,
      reason: ads[i].advise.reason,
    })),
  };
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
  };
}

export { classifyProduct };
