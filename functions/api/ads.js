import { adviseForAd, adviseForAdset, benchmarkSummary, classifyProduct, loadAdviseContext } from "../../lib/dashboard/advise.js";

// Ad-level drill-down for one adset: every ad in it, with its day-by-day spend and conversions
// over the same 10-day window the adset row is built from, plus each ad's own Keep/Pause and the
// adset verdict they roll up to (see lib/cpp-benchmark/README.md).
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
  let benchmark;
  let adsetAdvise = null;
  try {
    const ctx = await loadAdviseContext(env.DB);
    const product = classifyProduct(campaignName, ctx.cfg);
    if (!product) {
      benchmark = { available: false, reason: "unclassified_campaign", campaign: campaignName };
      for (const ad of ads) ad.advise = null;
    } else {
      benchmark = benchmarkSummary(ctx, product);
      for (const ad of ads) ad.advise = adviseForAd(ad, dates, ctx, product);
      adsetAdvise = adviseForAdset(ads);
    }
  } catch (err) {
    benchmark = { available: false, reason: "error", message: String((err && err.message) || err) };
    for (const ad of ads) ad.advise = null;
  }

  return Response.json(
    { ads, dates, reportDate: results.length ? results[0].report_date : null, benchmark, adsetAdvise },
    { headers: { "Cache-Control": "no-store" } }
  );
}
