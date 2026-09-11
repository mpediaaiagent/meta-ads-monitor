import {
  buildBenchmarks,
  classifyProduct,
  evaluateAd,
  resolveConfig,
  STATUS,
} from "../../lib/cpp-benchmark/src/index.js";

const CFG = resolveConfig();

// Ad-level drill-down for one adset: every ad in it, with its day-by-day spend and
// conversions over the same 10-day window the adset row itself is built from, plus each ad's
// incubation Keep/Pause (see lib/cpp-benchmark/README.md) computed here from raw rows.
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const account = url.searchParams.get("account");
  const adset = url.searchParams.get("adset");
  const campaign = url.searchParams.get("campaign");

  if (!account || !adset) {
    return Response.json(
      { error: "account and adset are required" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  // campaign is optional but disambiguates: Meta reuses adset names across campaigns
  let sql =
    `SELECT ad_id, ad_name, ad_status, ad_created_date, campaign_name, spend_5d, conv_5d, spend_10d, conv_10d, daily_json, report_date
     FROM ad_snapshots
     WHERE team = 'marketing' AND ad_account = ? AND adset_name = ?`;
  const binds = [account, adset];
  if (campaign) {
    sql += " AND campaign_name = ?";
    binds.push(campaign);
  }
  sql += " ORDER BY spend_10d DESC, ad_name ASC";

  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  const ads = results.map((r) => {
    let daily = [];
    try {
      daily = JSON.parse(r.daily_json || "[]");
    } catch {
      daily = [];
    }
    return {
      id: r.ad_id,
      name: r.ad_name,
      status: r.ad_status,
      started: r.ad_created_date,
      spend5: r.spend_5d,
      conv5: r.conv_5d,
      spend10: r.spend_10d,
      conv10: r.conv_10d,
      daily,
    };
  });

  // every ad carries the same set of dates; hand the frontend one ordered list for its columns
  const dates = ads.length ? ads[0].daily.map((d) => d.d) : [];

  const campaignName = campaign || (results[0] && results[0].campaign_name) || "";
  const benchmark = await loadBenchmark(env, campaignName);
  for (const ad of ads) ad.advise = benchmark.available ? adviseFor(ad, dates, benchmark) : null;

  return Response.json(
    { ads, dates, reportDate: results.length ? results[0].report_date : null, benchmark: benchmark.summary },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * The product's benchmark, built from the raw rows of its successful ads (benchmark_ads +
 * benchmark_ad_daily, filled monthly). Only the first incubationMaxDay days are read: nothing
 * later can affect a benchmark for ads that are at most that old.
 */
async function loadBenchmark(env, campaignName) {
  const product = classifyProduct(campaignName, CFG);
  if (!product) {
    return { available: false, summary: { available: false, reason: "unclassified_campaign", campaign: campaignName } };
  }
  try {
    const [adsRes, runRes] = await env.DB.batch([
      env.DB.prepare("SELECT ad_id, campaign_name FROM benchmark_ads"),
      env.DB.prepare(
        "SELECT run_date, window_since, window_until, created_from, created_to FROM benchmark_runs ORDER BY run_date DESC LIMIT 1"
      ),
    ]);
    const campaignOf = new Map(
      adsRes.results.filter((a) => classifyProduct(a.campaign_name, CFG) === product).map((a) => [a.ad_id, a.campaign_name])
    );
    const ids = [...campaignOf.keys()];
    const run = runRes.results[0] || null;

    let dailyRows = [];
    if (ids.length) {
      const res = await env.DB.prepare(
        `SELECT d.ad_id, d.date, d.spend, d.purchases
         FROM benchmark_ad_daily d
         JOIN (SELECT ad_id, date(MIN(date), '+' || ? || ' days') AS last_day
               FROM benchmark_ad_daily WHERE ad_id IN (SELECT value FROM json_each(?)) GROUP BY ad_id) f
           ON f.ad_id = d.ad_id
         WHERE d.date <= f.last_day
         ORDER BY d.ad_id, d.date`
      )
        .bind(CFG.incubationMaxDay - 1, JSON.stringify(ids))
        .all();
      dailyRows = res.results;
    }

    const byAd = new Map();
    for (const r of dailyRows) {
      if (!byAd.has(r.ad_id)) byAd.set(r.ad_id, []);
      byAd.get(r.ad_id).push({ date: r.date, spend: r.spend, purchases: r.purchases });
    }
    const built = buildBenchmarks(
      [...byAd].map(([adId, daily]) => ({ adId, campaignName: campaignOf.get(adId), daily })),
      CFG
    );
    const b = built.products[product];
    return {
      available: true,
      product: b,
      summary: {
        available: true,
        product,
        cohortSize: b.cohortSize,
        refreshedOn: run ? run.run_date : null,
        windowSince: run ? run.window_since : null,
        createdTo: run ? run.created_to : null,
        cppMargin: CFG.cppMargin,
        incubationMaxDay: CFG.incubationMaxDay,
        successMinDays: CFG.successMinDays,
        firstPurchaseLimit: b.firstPurchaseLimit,
        days: b.days,
      },
    };
  } catch (err) {
    return { available: false, summary: { available: false, reason: "error", message: String(err && err.message || err) } };
  }
}

/**
 * One ad's Keep/Pause from its 10-day window. An ad created before the window's first day may
 * have spent before it too, so its day 1 is unknown — and it is at least 10 days old anyway,
 * past incubation. Everything else starts inside the window, so the window is its whole life.
 */
function adviseFor(ad, dates, benchmark) {
  if (!dates.length) return null;
  if (ad.started && ad.started < dates[0]) {
    return { status: STATUS.PAST_INCUBATION, ageDays: null, firstSpendDate: null, verdict: null, reason: null, days: [], startedBeforeWindow: true };
  }
  const daily = ad.daily.map((p) => ({ date: p.d, spend: Number(p.s) || 0, purchases: Number(p.c) || 0 }));
  return evaluateAd(daily, benchmark.product, { through: dates[dates.length - 1] });
}
