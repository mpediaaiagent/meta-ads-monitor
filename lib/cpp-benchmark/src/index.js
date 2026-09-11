// Public entry point. See ../README.md for the input and output contract.

import { SCHEMA_VERSION } from "./constants.js";
import { describeConfig, resolveConfig } from "./config.js";
import { curvesFromHistories } from "./curve.js";
import { recordsFromHistories } from "./evaluate.js";
import { groupHistories } from "./input.js";

/**
 * The one-call path: builds every product's curve from `rows`, then evaluates every ad-day in
 * those same rows against it.
 *
 * @param {object[]} rows  flat daily rows — see groupHistories in ./input.js for the shape
 * @param {object} [options] overrides for DEFAULT_CONFIG
 * @returns {{ schemaVersion: number, config: object, curves: object, records: import("./evaluate.js").DailyRecord[] }}
 */
export function runBenchmark(rows, options) {
  const cfg = resolveConfig(options);
  const histories = groupHistories(rows, cfg);
  const curves = curvesFromHistories(histories, cfg);
  return {
    schemaVersion: SCHEMA_VERSION,
    config: describeConfig(cfg),
    curves,
    records: recordsFromHistories(histories, curves, cfg),
  };
}

export { buildBenchmarkCurves, marginForDay, meetsGoal } from "./curve.js";
export { evaluateAds, classifyPosition, classifyTrajectory, decideRemark, reduceSpendUrgency } from "./evaluate.js";
export { DEFAULT_CONFIG, DEFAULT_PRODUCT_GOALS, resolveConfig, describeConfig, normalizeProduct } from "./config.js";
export { STATISTICS } from "./statistics.js";
export { InputError } from "./input.js";
export { SCHEMA_VERSION, STATUS, POSITION, TRAJECTORY, CONFIDENCE, REMARK, URGENCY } from "./constants.js";
