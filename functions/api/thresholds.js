export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    `SELECT product, cost_5d_threshold, purchase_5d_threshold, cost_10d_threshold, purchase_10d_threshold, updated_at
     FROM ad_closing_threshold
     ORDER BY product ASC`
  ).all();
  return Response.json(
    { thresholds: results },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { product } = body;
  if (!product) {
    return Response.json({ error: "product is required" }, { status: 400 });
  }

  const c5 = Number(body.cost_5d_threshold);
  const p5 = Number(body.purchase_5d_threshold);
  const c10 = Number(body.cost_10d_threshold);
  const p10 = Number(body.purchase_10d_threshold);

  if ([c5, p5, c10, p10].some((v) => Number.isNaN(v))) {
    return Response.json({ error: "all four threshold fields must be numbers" }, { status: 400 });
  }

  const result = await env.DB.prepare(
    `UPDATE ad_closing_threshold
     SET cost_5d_threshold = ?, purchase_5d_threshold = ?, cost_10d_threshold = ?, purchase_10d_threshold = ?, updated_at = datetime('now')
     WHERE product = ?`
  )
    .bind(c5, p5, c10, p10, product)
    .run();

  if (result.meta.changes === 0) {
    return Response.json({ error: `no threshold row found for product "${product}"` }, { status: 404 });
  }
  return Response.json({ ok: true });
}
