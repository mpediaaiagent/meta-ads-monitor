import { normalizeProduct } from "./config.js";

const DAY_MS = 86_400_000;
const NON_NEGATIVE_FIELDS = ["spend", "purchases", "cumSpend", "cumPurchases"];

export class InputError extends Error {
  constructor(issues) {
    const shown = issues.slice(0, 10);
    const more = issues.length - shown.length;
    super(
      `Invalid cpp-benchmark input — ${issues.length} problem(s):\n  - ${shown.join("\n  - ")}` +
        (more > 0 ? `\n  - …and ${more} more (see error.issues)` : "")
    );
    this.name = "InputError";
    this.issues = issues;
  }
}

/**
 * Validates the flat daily rows and groups them into one lifetime history per ad, day 1 first.
 *
 * Expected row: { adId, product, date: "YYYY-MM-DD", ageDays (1 = first day), spend, purchases,
 * cumSpend, cumPurchases, cumCpp? }. Cumulative fields are the source of truth. cumCpp is
 * optional and only cross-checked, because a zero-purchase day's CPP has no agreed encoding
 * (null, 0 and Infinity all turn up in practice).
 *
 * Any problem throws an InputError that lists every issue. Rows are never skipped: a silently
 * dropped row is how the adset undercount bug hid (see the project README), and a history with a
 * hole in it would shift every later day's comparison.
 */
export function groupHistories(rows, cfg) {
  if (!Array.isArray(rows)) throw new InputError(["input must be an array of daily rows"]);
  const issues = [];
  const byAd = new Map();

  rows.forEach((row, i) => {
    const at = `row ${i}${row?.adId != null ? ` (ad ${row.adId})` : ""}`;
    if (row === null || typeof row !== "object") {
      issues.push(`${at}: not an object`);
      return;
    }
    const problems = rowProblems(row, cfg);
    if (problems.length) {
      issues.push(...problems.map((p) => `${at}: ${p}`));
      return;
    }

    const adId = String(row.adId).trim();
    const product = normalizeProduct(row.product);
    let history = byAd.get(adId);
    if (!history) {
      history = { adId, product, days: [] };
      byAd.set(adId, history);
    } else if (history.product !== product) {
      issues.push(`${at}: product "${product}" but earlier rows for this ad say "${history.product}"`);
      return;
    }
    history.days.push({
      date: row.date,
      ageDays: row.ageDays,
      spend: row.spend,
      purchases: row.purchases,
      cumSpend: row.cumSpend,
      cumPurchases: row.cumPurchases,
    });
  });

  for (const history of byAd.values()) {
    const problem = continuityProblem(history);
    if (problem) issues.push(`ad ${history.adId}: ${problem}`);
  }

  if (issues.length) throw new InputError(issues);
  return [...byAd.values()].sort((a, b) => a.adId.localeCompare(b.adId));
}

function rowProblems(row, cfg) {
  const problems = [];
  const hasId = (typeof row.adId === "string" || typeof row.adId === "number") && String(row.adId).trim() !== "";
  if (!hasId) problems.push("adId is missing");

  const product = normalizeProduct(row.product);
  if (!Object.hasOwn(cfg.goals, product)) {
    problems.push(`product "${row.product}" has no day-10 goal (known: ${Object.keys(cfg.goals).join(", ")})`);
  }
  if (parseDay(row.date) === null) problems.push(`date ${JSON.stringify(row.date)} is not a YYYY-MM-DD date`);
  if (!Number.isInteger(row.ageDays) || row.ageDays < 1) {
    problems.push(`ageDays must be an integer >= 1, got ${row.ageDays}`);
  }
  for (const field of NON_NEGATIVE_FIELDS) {
    if (!(Number.isFinite(row[field]) && row[field] >= 0)) problems.push(`${field} must be a number >= 0, got ${row[field]}`);
  }

  if (problems.length === 0 && row.cumPurchases > 0 && row.cumCpp != null) {
    const derived = row.cumSpend / row.cumPurchases;
    if (!(Math.abs(row.cumCpp - derived) <= Math.max(0.01, derived * 1e-3))) {
      problems.push(`cumCpp ${row.cumCpp} disagrees with cumSpend / cumPurchases = ${derived}`);
    }
  }
  return problems;
}

/** Histories must run day 1, 2, 3… on consecutive calendar dates, with no gaps or repeats. */
function continuityProblem(history) {
  const days = history.days.sort((a, b) => a.ageDays - b.ageDays);
  if (days[0].ageDays !== 1) {
    return `history starts at day ${days[0].ageDays}, not day 1 — this needs the ad's full lifetime history, not a trailing window`;
  }
  const start = parseDay(days[0].date);
  for (let k = 0; k < days.length; k++) {
    const d = days[k];
    if (d.ageDays !== k + 1) {
      return d.ageDays === k ? `day ${d.ageDays} appears more than once` : `day ${k + 1} is missing`;
    }
    const expected = start + k * DAY_MS;
    if (parseDay(d.date) !== expected) {
      return `day ${d.ageDays} is dated ${d.date}, expected ${formatDay(expected)} (day 1 was ${days[0].date})`;
    }
  }
  return null;
}

/** "YYYY-MM-DD" → UTC epoch ms, or null. Rejects impossible dates such as 2026-02-30. */
function parseDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return formatDay(ms) === s ? ms : null;
}

function formatDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
