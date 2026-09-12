// The D1 side of the Keep/Pause: reads the raw rows and hands them to lib/cpp-benchmark.
// Shared by /api/snapshots (adset Advise), /api/ads (the drill-down) and /api/thresholds (counts),
// so all three always agree. judgeAdset is the entry point for an adset and its ads.

import {
  BASIS,
  REASON,
  STATUS,
  VERDICT,
  adsetCpp,
  adsetFirstPurchase,
  adsetSpendBeforeFirstPurchase,
  buildAdsetBenchmarks,
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
    db.prepare("SELECT product, max_cpp, max_spend_no_purchase FROM benchmark_thresholds"),
    db.prepare("SELECT ad_id, campaign_name, ad_account, adset_name FROM benchmark_ads"),
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
  const maxSpendNoPurchaseByProduct = {};
  for (const t of thresholdsRes.results) {
    const product = String(t.product).trim().toLowerCase();
    maxCppByProduct[product] = Number(t.max_cpp);
    // blank (NULL) means "no override" — the benchmark's own first-purchase limit stays in charge
    maxSpendNoPurchaseByProduct[product] = t.max_spend_no_purchase == null ? null : Number(t.max_spend_no_purchase);
  }
  const cfg = resolveConfig({ maxCppByProduct, maxSpendNoPurchaseByProduct });

  const adMeta = new Map(adsRes.results.map((a) => [a.ad_id, a]));
  const byAd = new Map();
  for (const r of dailyRes.results) {
    if (!byAd.has(r.ad_id)) byAd.set(r.ad_id, []);
    byAd.get(r.ad_id).push({ date: r.date, spend: r.spend, purchases: r.purchases });
  }
  const built = buildBenchmarks(
    [...byAd].map(([adId, daily]) => ({ adId, campaignName: adMeta.get(adId)?.campaign_name ?? "", daily })),
    cfg
  );

  /*
   * The adset-level benchmark, from the same stored rows grouped by adset instead of by ad.
   *
   * Caveat worth knowing before trusting a number: benchmark_ads holds only ads that ran 11+ days,
   * so a past adset is rebuilt here from its long-running ads alone — its short-lived ads are not
   * stored and are missing from the sum. The live adset it is compared against uses *all* of its
   * ads. That makes the historical line a little cheaper than those adsets really were, so the
   * rule leans towards Pause rather than away from it. Fixing it properly means storing every ad
   * of a qualifying adset in the monthly refresh, not a change on this side.
   */
  const byAdset = new Map();
  for (const [adId, daily] of byAd) {
    const meta = adMeta.get(adId);
    if (!meta) continue;
    const key = `${meta.ad_account}|${meta.campaign_name}|${meta.adset_name}`;
    if (!byAdset.has(key)) byAdset.set(key, { adsetKey: key, campaignName: meta.campaign_name, byDate: new Map() });
    const entry = byAdset.get(key);
    for (const d of daily) {
      const t = entry.byDate.get(d.date) || { date: d.date, spend: 0, purchases: 0 };
      t.spend = Math.round((t.spend + (Number(d.spend) || 0)) * 100) / 100;
      t.purchases += Number(d.purchases) || 0;
      entry.byDate.set(d.date, t);
    }
  }
  const adsetBuilt = buildAdsetBenchmarks(
    [...byAdset.values()].map((e) => ({ adsetKey: e.adsetKey, campaignName: e.campaignName, daily: [...e.byDate.values()] })),
    cfg
  );

  return { cfg, products: built.products, adsetProducts: adsetBuilt.products, run: runRes.results[0] || null };
}

/** What the drill-down legend and the thresholds panel show about one product's benchmark. */
export function benchmarkSummary(ctx, product) {
  const b = ctx.products[product];
  const ab = ctx.adsetProducts?.[product] ?? null;
  return {
    /** the adset-level CPP benchmark this product's adsets are judged against */
    adsetBenchmark: ab ? { cohortSize: ab.cohortSize, candidates: ab.candidates, days: ab.days } : null,
    available: true,
    product,
    maxCpp: b.maxCpp,
    maxSpendNoPurchase: b.maxSpendNoPurchase,
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
 * The adset is Pause if ANY of three things says so — they are OR'd, not ranked:
 *
 * 1. Each ad on its own rules (adviseForAd), rolled up: Pause if any running ad is Pause.
 * 2. The adset's first purchase against the slowest successful ad (adsetFirstPurchase). When it
 *    took longer, the adset and every ad under it are Pause, whatever their own verdicts, which
 *    are kept in `own`. Checked only when every ad started inside the 10-day window: for an older
 *    adset the first purchase may predate the data, and guessing would pause good adsets.
 * 3. The adset's own cumulative CPP against past adsets' on the same day (adsetCpp). An adset can
 *    be built of individually-acceptable ads and still cost more per purchase than any adset that
 *    worked before. Guarded the same way as 2, and for the same reason: day alignment needs the
 *    adset's real day 1 to be inside the window. Unlike 2 it does NOT cascade to the ads — the ad
 *    column keeps saying which of them are worth keeping.
 * 4. The adset's spend before its first purchase against past adsets' (adsetSpendBeforeFirstPurchase).
 *    The same question as 3 but for an adset that hasn't converted at all, so there is no CPP to
 *    compare. Same guard, and it doesn't cascade either.
 *
 * 3 and 4 are mutually exclusive by construction: 3 needs a purchase, 4 needs there to be none.
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

  const cpp = adsetCppCheck(ads, dates, ctx, product);
  const costly = cpp.checked && cpp.verdict === VERDICT.PAUSE;

  const spend = adsetSpendCheck(ads, dates, ctx, product);
  const overspent = spend.checked && spend.verdict === VERDICT.PAUSE;

  // whichever rule fires decides; the first-purchase one is named first because it is the only
  // one that also rewrites the ads' verdicts
  let basis = "ads";
  if (slow) basis = BASIS.ADSET;
  else if (costly) basis = BASIS.ADSET_CPP;
  else if (overspent) basis = BASIS.ADSET_SPEND;

  return {
    verdict: slow || costly || overspent || roll.verdict === VERDICT.PAUSE ? VERDICT.PAUSE : roll.verdict,
    basis,
    counted: roll.counted,
    ignoredPaused: roll.ignoredPaused,
    pauseAds, // on their own rules, before any adset flag
    firstPurchase,
    adsetCpp: cpp,
    adsetSpend: spend,
  };
}

/** The adset's spend before its first purchase, when the window shows its whole life. */
function adsetSpendCheck(ads, dates, ctx, product) {
  const blocked = adsetWindowGuard(ads, dates, product);
  if (blocked) return blocked;
  const out = adsetSpendBeforeFirstPurchase(adsetSeries(ads), ctx.adsetProducts?.[product] ?? null, ctx.cfg, {
    through: dates[dates.length - 1],
  });
  return { checked: out.verdict !== null, notChecked: out.verdict === null ? out.reason : null, ...out };
}

/** The ad rows as the calculation module wants them: `{d,s,c}` keys spelled out, numbers coerced. */
function adsetSeries(ads) {
  return ads.map((a) => ({
    daily: (a.daily || []).map((p) => ({ date: p.d, spend: Number(p.s) || 0, purchases: Number(p.c) || 0 })),
  }));
}

/**
 * Can an adset-level rule read this adset at all? All three need the window to show its real day 1,
 * which it only does when every ad started inside the window. For an older adset the first purchase
 * (and the first day with spend) may predate the data, and guessing would pause good adsets.
 */
function adsetWindowGuard(ads, dates, product) {
  if (!dates.length || !product) return { checked: false, notChecked: "no_data" };
  if (!ads.every((a) => a.started && a.started >= dates[0])) return { checked: false, notChecked: "started_before_window" };
  return null;
}

/** The adset's cumulative CPP against past adsets', when the window shows its whole life. */
function adsetCppCheck(ads, dates, ctx, product) {
  const blocked = adsetWindowGuard(ads, dates, product);
  if (blocked) return blocked;
  const out = adsetCpp(adsetSeries(ads), ctx.adsetProducts?.[product] ?? null, ctx.cfg, { through: dates[dates.length - 1] });
  return { checked: out.verdict !== null, notChecked: out.verdict === null ? out.reason : null, ...out };
}

/** The adset's first purchase against the slowest successful ad, when the window shows its whole life. */
function firstPurchaseCheck(ads, dates, ctx, product) {
  const blocked = adsetWindowGuard(ads, dates, product);
  if (blocked) return blocked;
  return { checked: true, notChecked: null, ...adsetFirstPurchase(adsetSeries(ads), ctx.products[product], { through: dates[dates.length - 1] }) };
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
