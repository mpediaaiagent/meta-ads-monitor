// Step 1: work out this run's dates.
//
//   node window.mjs --run-date=2026-10-01 --last-created-to=2026-08-27
//
// --last-created-to is MAX(created_to) from benchmark_runs (omit it if the table is empty).
// --created-from / --created-to override the slice (dry runs, or re-running a failed month).
// Prints the window and the slice of creation dates this run must process, and saves them.

import path from "node:path";
import { TAIL_DAYS, addDays, args, monthsBefore, workDir, writeJson } from "./common.mjs";

const { flags } = args();
const runDate = flags["run-date"];
if (!/^\d{4}-\d{2}-\d{2}$/.test(runDate || "")) throw new Error("--run-date=YYYY-MM-DD is required");

const until = addDays(runDate, -1); // last complete day
const windowSince = monthsBefore(runDate, 3); // "last 3 months from today"
const defaultCreatedTo = addDays(until, -TAIL_DAYS); // newest ads whose day 11 is safely inside the data
const lastCreatedTo = flags["last-created-to"];
let createdFrom = lastCreatedTo && addDays(lastCreatedTo, 1) > windowSince ? addDays(lastCreatedTo, 1) : windowSince;
let createdTo = defaultCreatedTo;
// manual slice (dry runs, re-running a month): must still sit inside the window
if (flags["created-from"]) createdFrom = flags["created-from"];
if (flags["created-to"]) createdTo = flags["created-to"];
if (createdFrom < windowSince || createdTo > defaultCreatedTo) {
  throw new Error(`slice ${createdFrom}..${createdTo} must lie within ${windowSince}..${defaultCreatedTo}`);
}

const w = { runDate, windowSince, until, createdFrom, createdTo, tailDays: TAIL_DAYS, empty: createdFrom > createdTo };
writeJson(path.join(workDir(), "window.json"), w);
console.log(JSON.stringify(w, null, 2));
if (w.empty) console.log("NOTHING NEW TO PROCESS: created_from is after created_to. Only the prune step (and the run row) apply.");
