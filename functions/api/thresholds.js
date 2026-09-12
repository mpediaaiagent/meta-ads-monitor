import { loadAdviseContext } from "../../lib/dashboard/advise.js";

// The two per-product thresholds (D1 table benchmark_thresholds), edited from the dashboard's
// "Edit Thresholds" panel. Read on every request, so a save applies at once.
//
// - max_cpp: decides which 11+ day ads count as successful (cumulative CPP at day 10 at or under
//   it) and judges ads past day 9 on their 10-day window.
// - max_spend_no_purchase: the most an ad may spend before its first purchase. Optional; when it
//   is NULL the limit derived from the successful ads' own spend-before-first-purchase applies,
//   which is how this worked before the column existed.

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    "SELECT product, max_cpp, max_spend_no_purchase, updated_at FROM benchmark_thresholds ORDER BY product ASC"
  ).all();

  // how many stored 11+ day ads each threshold lets into the benchmark, so the effect of a
  // number is visible right next to it
  let counts = {};
  let countsError = null;
  try {
    const ctx = await loadAdviseContext(env.DB);
    for (const [product, b] of Object.entries(ctx.products)) {
      counts[product] = {
        candidates: b.candidates,
        successful: b.cohortSize,
        // what the successful ads alone would set, so an empty override shows the number in force
        derivedSpendNoPurchase: b.firstPurchaseLimit.derived,
      };
    }
  } catch (err) {
    countsError = String((err && err.message) || err);
  }

  const thresholds = results.map((t) => ({
    ...t,
    ...(counts[t.product] || { candidates: null, successful: null, derivedSpendNoPurchase: null }),
  }));
  return Response.json({ thresholds, countsError }, { headers: { "Cache-Control": "no-store" } });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json().catch(() => ({}));
  const product = String(body.product || "").trim().toLowerCase();
  if (!product) {
    return Response.json({ error: "product is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const maxCpp = Number(body.max_cpp);
  if (!Number.isFinite(maxCpp) || maxCpp <= 0) {
    return Response.json({ error: "max_cpp must be a number above 0" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  // Optional. Empty string, null or undefined all clear it back to the derived limit; anything
  // else must be a real number above 0, so a typo can't silently wipe the threshold.
  const raw = body.max_spend_no_purchase;
  let maxSpendNoPurchase = null;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    maxSpendNoPurchase = Number(raw);
    if (!Number.isFinite(maxSpendNoPurchase) || maxSpendNoPurchase <= 0) {
      return Response.json(
        { error: "max_spend_no_purchase must be a number above 0, or blank to use the benchmark's own limit" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }
  }

  const result = await env.DB.prepare(
    "UPDATE benchmark_thresholds SET max_cpp = ?, max_spend_no_purchase = ?, updated_at = datetime('now') WHERE product = ?"
  )
    .bind(maxCpp, maxSpendNoPurchase, product)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: `no threshold row for product "${product}"` }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
