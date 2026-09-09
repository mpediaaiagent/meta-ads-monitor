export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT advise, ad_account, adset_name, campaign_name, cost_5d, cost_10d, age_days, conv_5d, conv_10d, report_date
     FROM adset_snapshots
     WHERE team = 'marketing'
     ORDER BY ad_account ASC, cost_10d DESC`
  ).all();

  const rows = results.map((r) => ({
    advise: r.advise,
    account: r.ad_account,
    adset: r.adset_name,
    campaign: r.campaign_name,
    cost5: r.cost_5d,
    cost10: r.cost_10d,
    age: r.age_days,
    conv5: r.conv_5d,
    conv10: r.conv_10d,
  }));

  const reportDate = results.length ? results[0].report_date : null;
  return Response.json(
    { rows, reportDate },
    { headers: { "Cache-Control": "no-store" } }
  );
}
