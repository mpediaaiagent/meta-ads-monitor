// Step 5: pick the successful ads and write the SQL that stores them.
//
//   node build.mjs
//
// Successful = spent on its day 11 or later, day 1 being its first day with spend — decided by
// lib/cpp-benchmark, the same code the dashboard uses, so both count days identically. For each
// successful ad it stores the raw daily rows of days 1–11 (zero days included).
//
// Writes sql/NN-*.sql, one statement per file, each small enough for one D1 call, plus
// build.json with the expected row counts the D1 steps are checked against.

import fs from "node:fs";
import path from "node:path";
import { alignFromFirstSpend, isSuccessful, classifyProduct, resolveConfig } from "../../lib/cpp-benchmark/src/index.js";
import { money, purchases, q, readJson, workDir, writeJson } from "./common.mjs";

const STORED_DAYS = 11;
const MAX_SQL_BYTES = 15_000;

const cfg = resolveConfig();
const dir = workDir();
const w = readJson(path.join(dir, "window.json"));
const plan = readJson(path.join(dir, "plan.json"));
const meta = new Map(readJson(path.join(dir, "candidates.json")).map((c) => [c.id, c]));

const missing = plan.filter((b) => !fs.existsSync(path.join(dir, "pages", `${b.key}.json`))).map((b) => b.key);
if (missing.length) throw new Error(`not every call has a verified result yet: ${missing.join(" ")} — run status.mjs`);

const dailyByAd = new Map();
for (const b of plan) {
  for (const r of readJson(path.join(dir, "pages", `${b.key}.json`))) {
    if (!dailyByAd.has(r.id)) dailyByAd.set(r.id, []);
    dailyByAd.get(r.id).push({ date: r.date_start, spend: money(r.amount_spent), purchases: purchases(r.results) });
  }
}

const winners = [];
const undetermined = [];
let notSuccessful = 0;
let neverSpent = 0;
for (const [id, daily] of dailyByAd) {
  const days = alignFromFirstSpend(daily);
  if (!days) neverSpent++;
  else if (isSuccessful(days, cfg)) winners.push({ ...meta.get(id), days: days.slice(0, STORED_DAYS) });
  else if (days.length < cfg.successMinDays) undetermined.push(id); // its day 11 lies past the data pulled
  else notSuccessful++;
}

// ---- SQL ----
for (const f of fs.readdirSync(path.join(dir, "sql"))) fs.rmSync(path.join(dir, "sql", f));
let n = 0;
const emit = (name, sql) => fs.writeFileSync(path.join(dir, "sql", `${String(++n).padStart(2, "0")}-${name}.sql`), sql + "\n");

function batched(name, head, tuples) {
  let buf = [];
  let size = head.length;
  for (const t of tuples) {
    if (buf.length && size + t.length + 2 > MAX_SQL_BYTES) {
      emit(name, head + buf.join(",\n") + ";");
      buf = [];
      size = head.length;
    }
    buf.push(t);
    size += t.length + 2;
  }
  if (buf.length) emit(name, head + buf.join(",\n") + ";");
}

batched(
  "ads",
  "INSERT INTO benchmark_ads_staging (ad_id, ad_account, campaign_name, adset_name, ad_name, ad_created_date, run_date) VALUES\n",
  winners.map((x) => `(${q(x.id)},${q(x.account)},${q(x.campaign)},${q(x.adset)},${q(x.name)},${q(x.created)},${q(w.runDate)})`)
);
const dailyTuples = winners.flatMap((x) => x.days.map((d) => `(${q(x.id)},${q(d.date)},${d.spend},${d.purchases})`));
batched("daily", "INSERT INTO benchmark_ad_daily_staging (ad_id, date, spend, purchases) VALUES\n", dailyTuples);

const byProduct = {};
for (const x of winners) {
  const p = classifyProduct(x.campaign, cfg) ?? "unclassified";
  byProduct[p] = (byProduct[p] || 0) + 1;
}
const summary = {
  candidates: meta.size,
  successful: winners.length,
  notSuccessful,
  neverSpentInRange: neverSpent,
  undetermined: undetermined.length,
  undeterminedAdIds: undetermined,
  successfulByProduct: byProduct,
  expectedAdsRows: winners.length,
  expectedDailyRows: dailyTuples.length,
  sqlFiles: fs.readdirSync(path.join(dir, "sql")).sort(),
};
writeJson(path.join(dir, "build.json"), { ...summary, successfulAdIds: winners.map((x) => x.id).sort() });
console.log(JSON.stringify(summary, null, 2));
