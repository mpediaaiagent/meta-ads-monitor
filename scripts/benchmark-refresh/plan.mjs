// Step 3: turn the ad listings into candidate ads and a list of daily-data calls.
//
//   node plan.mjs tb=<saved listing page> tb=<page 2> tp=<page 1> ...
//
// A candidate was created inside this run's slice and spent something in the window. Its daily
// rows are then fetched in calls grouped by creation date, each call returning ONE response of at
// most 1000 rows: with the ad.id filter Meta silently cuts a response at the limit and gives no
// cursor, so a call must never need a second page. Meta returns a row for every ad on every day
// of the range (zeros included), so each call's row count is known in advance — rec.mjs checks it.

import path from "node:path";
import { ACCOUNTS, TAIL_DAYS, addDays, args, daysBetween, loadMetaResult, money, readJson, workDir, writeJson } from "./common.mjs";

const MAX_ROWS = 1000; // Meta's cap per response
const MIN_ROWS = 450; // small responses come back inline instead of saved to a file; pad up to this
const MAX_SPAN = 6; // creation dates grouped into one call at most this many days apart

const dir = workDir();
const w = readJson(path.join(dir, "window.json"));
const { rest } = args();

const candidates = [];
const seen = new Set();
const listed = { tb: 0, tp: 0 };
for (const a of rest) {
  const [acct, file] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
  if (!ACCOUNTS[acct]) throw new Error(`unknown account prefix "${acct}" (use tb= or tp=)`);
  for (const r of loadMetaResult(file).rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    listed[acct]++;
    const created = String(r.created_time || "").slice(0, 10);
    if (created < w.createdFrom || created > w.createdTo) continue;
    if (!(money(r.amount_spent) > 0)) continue;
    candidates.push({ acct, account: ACCOUNTS[acct].name, id: r.id, name: r.name, campaign: r.campaign_name, adset: r.adset_name, created });
  }
}

const plan = [];
for (const acct of Object.keys(ACCOUNTS)) {
  const ads = candidates.filter((c) => c.acct === acct).sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0));
  const dates = [...new Set(ads.map((a) => a.created))];
  let i = 0;
  let n = 0;
  while (i < dates.length) {
    const first = dates[i];
    let j = i;
    const idsOn = (d) => ads.filter((a) => a.created === d).map((a) => a.id);
    let ids = idsOn(first);
    const rangeDays = (last) => daysBetween(first, minDay(addDays(last, TAIL_DAYS), w.until)) + 1;
    while (j + 1 < dates.length && daysBetween(first, dates[j + 1]) <= MAX_SPAN && ids.length * rangeDays(dates[j]) < 900) {
      j++;
      ids = ids.concat(idsOn(dates[j]));
    }
    const until = minDay(addDays(dates[j], TAIL_DAYS), w.until);
    const days = daysBetween(first, until) + 1;
    // split so every call fits one response
    const parts = Math.ceil((ids.length * days) / MAX_ROWS);
    const per = Math.ceil(ids.length / parts);
    for (let p = 0; p < parts; p++) {
      const chunk = ids.slice(p * per, (p + 1) * per);
      let since = first;
      let d = days;
      // pad small calls by starting earlier: the extra days are before these ads existed, so they are zero rows
      if (chunk.length * d < MIN_ROWS) {
        d = Math.min(Math.ceil(MIN_ROWS / chunk.length), Math.floor(MAX_ROWS / chunk.length));
        since = addDays(until, -(d - 1));
      }
      plan.push({ key: `${acct}_${n}${parts > 1 ? "abcdefgh"[p] : ""}`, acct, accountId: ACCOUNTS[acct].id, since, until, days: d, ids: chunk, expected: chunk.length * d });
    }
    n++;
    i = j + 1;
  }
}

writeJson(path.join(dir, "candidates.json"), candidates);
writeJson(path.join(dir, "plan.json"), plan);
console.log(JSON.stringify({ listed, candidates: candidates.length, calls: plan.length, rows: plan.reduce((s, b) => s + b.expected, 0) }));
console.log("KEYS: " + plan.map((b) => b.key).join(" "));

function minDay(a, b) {
  return a < b ? a : b;
}
