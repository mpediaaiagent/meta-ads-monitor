import { loadAdviseContext } from "../../lib/dashboard/advise.js";

// Per-product CPP threshold (D1 table benchmark_thresholds), edited from the dashboard's
// "Edit Thresholds" panel. It decides which 11+ day ads count as successful (cumulative CPP at
// day 10 at or under it) and judges ads past day 9. Read on every request, so a save applies at once.

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    "SELECT product, max_cpp, updated_at FROM benchmark_thresholds ORDER BY product ASC"
  ).all();

  // how many stored 11+ day ads each threshold lets into the benchmark, so the effect of a
  // number is visible right next to it
  let counts = {};
  let countsError = null;
  try {
    const ctx = await loadAdviseContext(env.DB);
    for (const [product, b] of Object.entries(ctx.products)) {
      counts[product] = { candidates: b.candidates, successful: b.cohortSize };
    }
  } catch (err) {
    countsError = String((err && err.message) || err);
  }

  const thresholds = results.map((t) => ({ ...t, ...(counts[t.product] || { candidates: null, successful: null }) }));
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

  const result = await env.DB.prepare(
    "UPDATE benchmark_thresholds SET max_cpp = ?, updated_at = datetime('now') WHERE product = ?"
  )
    .bind(maxCpp, product)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: `no threshold row for product "${product}"` }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
