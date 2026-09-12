import { benchmarkSummary, classifyProduct, judgeAdset, loadAdviseContext } from "../../lib/dashboard/advise.js";

// Ad-level drill-down for one adset: every ad in it, with its day-by-day spend and conversions
// over the same 10-day window the adset row is built from, plus each ad's Keep/Pause and the
// adset's verdict, decided together by judgeAdset (see lib/cpp-benchmark/README.md).
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
  // ad_thumbs is a left join on purpose: it is filled by a separate task and is allowed to be
  // missing or stale for an ad without costing the drill-down its numbers.
  let sql =
    `SELECT s.ad_id, s.ad_name, s.ad_status, s.ad_created_date, s.campaign_name, s.spend_5d, s.conv_5d,
            s.spend_10d, s.conv_10d, s.daily_json, s.report_date, t.thumb_url, t.object_type AS creative_type
     FROM ad_snapshots s
     LEFT JOIN ad_thumbs t ON t.ad_id = s.ad_id
     WHERE s.team = 'marketing' AND s.ad_account = ? AND s.adset_name = ?`;
  const binds = [account, adset];
  if (campaign) {
    sql += " AND s.campaign_name = ?";
    binds.push(campaign);
  }
  sql += " ORDER BY s.spend_10d DESC, s.ad_name ASC";

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
      /** Meta's own thumbnail link, or null when the thumbnail task hasn't covered this ad yet */
      thumb: r.thumb_url || null,
      creativeType: r.creative_type || null,
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
      adsetAdvise = judgeAdset(ads, dates, ctx, product);
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
