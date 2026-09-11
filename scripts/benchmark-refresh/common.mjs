// Shared helpers for the monthly benchmark refresh. See README.md in this folder.

import fs from "node:fs";
import path from "node:path";

/** Daily pulls cover creation date .. creation date + TAIL_DAYS, so day 11 (+ slack for a late first delivery) is inside. */
export const TAIL_DAYS = 14;

export const ACCOUNTS = Object.freeze({
  tb: { name: "TruBuddy", id: "949249031427990" },
  tp: { name: "Tuhin Paul", id: "807109673203041" },
});

/** Scratch directory for one run. Everything this pipeline writes goes here (never into the repo). */
export function workDir() {
  const arg = process.argv.find((a) => a.startsWith("--work="));
  const dir = arg ? arg.slice(7) : process.env.BENCH_WORK || "/tmp/benchmark-refresh";
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.mkdirSync(path.join(dir, "state"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sql"), { recursive: true });
  return dir;
}

/** `--name=value` flags; the rest are positional. */
export function args() {
  const flags = {};
  const rest = [];
  for (const a of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) flags[m[1]] = m[2];
    else rest.push(a);
  }
  return { flags, rest };
}

/** A saved ads_get_ad_entities result → its rows and cursor. */
export function loadMetaResult(file) {
  const o = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = typeof o.ad_entities === "string" ? JSON.parse(o.ad_entities) : o.ad_entities;
  if (!Array.isArray(rows)) throw new Error(`${file}: no ad_entities array — is this an ads_get_ad_entities result?`);
  return { rows, cursor: (o.pagination && o.pagination.next_cursor) || null };
}

/** "₹1,234.56 INR" (with a non-breaking space) → 1234.56 */
export function money(s) {
  return Number(String(s ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

/** results.values[0].value when present; a zero day is { value: "Not available" } with no values. */
export function purchases(results) {
  return results && Array.isArray(results.values) && results.values.length ? Number(results.values[0].value) || 0 : 0;
}

const DAY_MS = 86_400_000;
export const toMs = (d) => Date.parse(`${d}T00:00:00Z`);
export const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => toDay(toMs(d) + n * DAY_MS);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY_MS);

/** Same day-of-month, `n` calendar months earlier (clamped to the month's last day). */
export function monthsBefore(d, n) {
  const [y, m, day] = d.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 - n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return toDay(target.getTime());
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

/** SQL string literal. */
export const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
