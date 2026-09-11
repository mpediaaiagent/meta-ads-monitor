import { classifyProduct, judgeAdset, loadAdviseContext } from "../../lib/dashboard/advise.js";

// Every adset in today's snapshot. Its Advise is no longer the daily task's threshold rule: it is
// Pause when its first purchase took longer than the slowest successful ad's, and otherwise
// rolled up from the adset's own ads — Pause if at least one running ad is Pause, Keep if they
// are all Keep (see lib/cpp-benchmark/README.md). If the ad-level data can't be loaded, the
// daily task's stored Advise is returned instead and the response says so.
export async function onRequestGet(context) {
  const { env } = context;
  const [adsetRes, adRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT advise, ad_account, adset_name, campaign_name, cost_5d, cost_10d, age_days, conv_5d, conv_10d, report_date
       FROM adset_snapshots
       WHERE team = 'marketing'
       ORDER BY ad_account ASC, cost_10d DESC`
    ),
    env.DB.prepare(
      `SELECT ad_account, adset_name, campaign_name, ad_name, ad_status, ad_created_date, spend_10d, conv_10d, daily_json
       FROM ad_snapshots
       WHERE team = 'marketing'`
    ),
  ]);

  const adsByAdset = new Map();
  for (const r of adRes.results) {
    const key = r.ad_account + "|" + r.adset_name + "|" + r.campaign_name;
    let daily = [];
    try {
      daily = JSON.parse(r.daily_json || "[]");
    } catch {
      daily = [];
    }
    if (!adsByAdset.has(key)) adsByAdset.set(key, []);
    adsByAdset.get(key).push({
      name: r.ad_name,
      status: r.ad_status,
      started: r.ad_created_date,
      spend10: r.spend_10d,
      conv10: r.conv_10d,
      daily,
    });
  }

  let ctx = null;
  let adviseError = null;
  try {
    ctx = await loadAdviseContext(env.DB);
  } catch (err) {
    adviseError = String((err && err.message) || err);
  }

  const rows = adsetRes.results.map((r) => {
    const row = {
      advise: r.advise,
      account: r.ad_account,
      adset: r.adset_name,
      campaign: r.campaign_name,
      cost5: r.cost_5d,
      cost10: r.cost_10d,
      age: r.age_days,
      conv5: r.conv_5d,
      conv10: r.conv_10d,
      adviseDetail: null,
    };
    if (!ctx) {
      row.adviseDetail = { source: "daily_task_fallback" };
      return row;
    }
    const ads = adsByAdset.get(r.ad_account + "|" + r.adset_name + "|" + r.campaign_name) || [];
    const product = classifyProduct(r.campaign_name, ctx.cfg);
    if (!product || !ads.length) {
      row.advise = null;
      row.adviseDetail = { source: "ads", product, reason: !product ? "unclassified_campaign" : "no_ad_data", counted: 0, pauseAds: [] };
      return row;
    }
    const dates = ads[0].daily.map((d) => d.d);
    const roll = judgeAdset(ads, dates, ctx, product);
    row.advise = roll.verdict;
    row.adviseDetail = { source: "ads", product, ads: ads.length, ...roll };
    return row;
  });

  const reportDate = adsetRes.results.length ? adsetRes.results[0].report_date : null;
  return Response.json(
    { rows, reportDate, adviseSource: ctx ? "ads" : "daily_task_fallback", adviseError },
    { headers: { "Cache-Control": "no-store" } }
  );
}
