import { CONFIDENCE, POSITION, REMARK, SCHEMA_VERSION, STATUS, TRAJECTORY, URGENCY } from "./constants.js";
import { resolveConfig } from "./config.js";
import { groupHistories } from "./input.js";
import { comparableCpp, cumulativeCpp, passesFloor } from "./metrics.js";

/**
 * One ad on one day — the record the dashboard consumes. Every key is always present; fields that
 * don't apply are null rather than missing, so the shape never varies.
 *
 * @typedef {object} DailyRecord
 * @property {string} adId
 * @property {string} product           normalised product name, e.g. "adi anku"
 * @property {string} date              "YYYY-MM-DD"
 * @property {number} ageDays           1 = the ad's first day
 * @property {number} runwayDays        days left until the horizon (day 10); never negative
 * @property {number} cumSpend
 * @property {number} cumPurchases
 * @property {number|null} cumCpp       cumSpend / cumPurchases; null before the first purchase
 * @property {number|null} comparedCpp  the CPP actually compared with the benchmark (cumSpend when 0 purchases); null unless evaluated
 * @property {"evaluated"|"insufficient_data"|"beyond_benchmark_window"} status
 * @property {"ok"|"low"|null} confidence            the benchmark's confidence for this product/day; null unless evaluated
 * @property {"inside"|"near_edge"|"outside"|null} position   null unless evaluated with an ok-confidence benchmark
 * @property {"improving"|"flat"|"worsening"|"unknown"|null} trajectory  null unless evaluated
 * @property {number|null} trajectoryChange          relative change in comparedCpp over the lookback (-0.05 = 5% cheaper)
 * @property {string} remark                         see REMARK; mirrors status when not evaluated
 * @property {"low"|"medium"|"high"|null} urgency    set on reduce_spend only
 * @property {{ceiling: number|null, margin: number, upperBound: number|null, sampleSize: number}|null} benchmark  that day's curve point; null unless evaluated
 */

/**
 * Evaluates every ad-day in `rows` against curves built earlier by buildBenchmarkCurves. Pass the
 * same options the curves were built with.
 * @returns {DailyRecord[]}
 */
export function evaluateAds(rows, curves, options) {
  const cfg = resolveConfig(options);
  assertCurvesMatch(curves, cfg);
  return recordsFromHistories(groupHistories(rows, cfg), curves, cfg);
}

/** Same as evaluateAds, for histories that are already validated and grouped. */
export function recordsFromHistories(histories, curves, cfg) {
  const records = [];
  for (const history of histories) {
    const curve = curves.products[history.product];
    if (!curve) {
      throw new RangeError(`no benchmark curve for product "${history.product}" — build the curves with the same goals`);
    }
    for (let i = 0; i < history.days.length; i++) records.push(evaluateDay(history, i, curve, cfg));
  }
  return records;
}

function evaluateDay(history, i, curve, cfg) {
  const day = history.days[i];
  const record = {
    adId: history.adId,
    product: history.product,
    date: day.date,
    ageDays: day.ageDays,
    runwayDays: Math.max(0, cfg.horizonDays - day.ageDays),
    cumSpend: day.cumSpend,
    cumPurchases: day.cumPurchases,
    cumCpp: cumulativeCpp(day),
    comparedCpp: null,
    status: null,
    confidence: null,
    position: null,
    trajectory: null,
    trajectoryChange: null,
    remark: null,
    urgency: null,
    benchmark: null,
  };

  // Below the floor nothing is judged, however good or bad the raw CPP looks.
  if (!passesFloor(day, cfg.floor)) {
    return { ...record, status: STATUS.INSUFFICIENT_DATA, remark: REMARK.INSUFFICIENT_DATA };
  }
  if (day.ageDays > cfg.horizonDays) {
    return { ...record, status: STATUS.BEYOND_BENCHMARK_WINDOW, remark: REMARK.BEYOND_BENCHMARK_WINDOW };
  }

  const point = curve.days[day.ageDays - 1];
  const comparedCpp = comparableCpp(day);
  const { trajectory, change } = trajectoryAt(history.days, i, cfg);
  const position = point.confidence === CONFIDENCE.OK ? classifyPosition(comparedCpp, point) : null;
  const remark = decideRemark({ confidence: point.confidence, position, trajectory, runwayDays: record.runwayDays }, cfg);

  return {
    ...record,
    comparedCpp,
    status: STATUS.EVALUATED,
    confidence: point.confidence,
    position,
    trajectory,
    trajectoryChange: change,
    remark,
    urgency: remark === REMARK.REDUCE_SPEND ? reduceSpendUrgency(record.runwayDays, cfg) : null,
    benchmark: { ceiling: point.ceiling, margin: point.margin, upperBound: point.upperBound, sampleSize: point.sampleSize },
  };
}

// Absorbs float noise at the exact boundaries (280 × 1.1 is 308.00000000000006), so a value
// sitting precisely on a threshold lands on the side the rules say it should.
const EPSILON = 1e-9;
const atMost = (a, b) => a <= b + EPSILON * Math.max(1, Math.abs(b));

/** inside: at or under the ceiling · near_edge: above it but within the margin · outside: beyond ceiling + margin. */
export function classifyPosition(cpp, { ceiling, upperBound }) {
  if (atMost(cpp, ceiling)) return POSITION.INSIDE;
  if (atMost(cpp, upperBound)) return POSITION.NEAR_EDGE;
  return POSITION.OUTSIDE;
}

/** Direction of a CPP move. Lower CPP is better, so a drop is "improving". */
export function classifyTrajectory(fromCpp, toCpp, flatTolerance) {
  if (fromCpp === 0) return { trajectory: toCpp === 0 ? TRAJECTORY.FLAT : TRAJECTORY.WORSENING, change: null };
  const change = (toCpp - fromCpp) / fromCpp;
  if (atMost(Math.abs(change), flatTolerance)) return { trajectory: TRAJECTORY.FLAT, change };
  return { trajectory: change < 0 ? TRAJECTORY.IMPROVING : TRAJECTORY.WORSENING, change };
}

/**
 * Today's CPP against the oldest day in the lookback window that had itself cleared the floor.
 * Pre-floor days are skipped as a baseline for the same reason they aren't evaluated: a ₹20
 * day-1 "CPP" is noise, and comparing to it would call almost every ad worsening.
 */
function trajectoryAt(days, i, cfg) {
  const { lookbackDays, flatTolerance } = cfg.trajectory;
  for (let j = Math.max(0, i - lookbackDays); j < i; j++) {
    if (passesFloor(days[j], cfg.floor)) {
      return classifyTrajectory(comparableCpp(days[j]), comparableCpp(days[i]), flatTolerance);
    }
  }
  return { trajectory: TRAJECTORY.UNKNOWN, change: null };
}

// position × trajectory, read straight off the spec's table. "outside" isn't here because it
// ignores trajectory and turns on runway instead (see decideRemark).
const REMARK_MATRIX = Object.freeze({
  [POSITION.INSIDE]: {
    [TRAJECTORY.IMPROVING]: REMARK.SCALE_CANDIDATE,
    [TRAJECTORY.FLAT]: REMARK.HOLD_WATCH,
    [TRAJECTORY.WORSENING]: REMARK.HOLD_WATCH,
  },
  [POSITION.NEAR_EDGE]: {
    [TRAJECTORY.IMPROVING]: REMARK.HOLD,
    [TRAJECTORY.FLAT]: REMARK.REDUCE_SPEND,
    [TRAJECTORY.WORSENING]: REMARK.REDUCE_SPEND,
  },
});

/** Combines the signals into one remark. A low-confidence benchmark overrides everything else. */
export function decideRemark({ confidence, position, trajectory, runwayDays }, cfg) {
  if (confidence === CONFIDENCE.LOW) return REMARK.HOLD_MONITOR;
  if (position === POSITION.OUTSIDE) {
    return runwayDays <= cfg.runway.lowMaxDays ? REMARK.PAUSE_CANDIDATE : REMARK.WAIT_ONE_MORE_DAY;
  }
  const row = REMARK_MATRIX[position];
  if (!row) throw new RangeError(`cannot decide a remark for position "${position}"`);
  const effective = trajectory === TRAJECTORY.UNKNOWN ? cfg.trajectory.treatUnknownAs : trajectory;
  const remark = row[effective];
  if (!remark) throw new RangeError(`cannot decide a remark for trajectory "${trajectory}"`);
  return remark;
}

/** reduce_spend gets more urgent as the days left to reach the goal run out. */
export function reduceSpendUrgency(runwayDays, cfg) {
  const { highMaxDays, mediumMaxDays } = cfg.runway.reduceSpendUrgency;
  if (runwayDays <= highMaxDays) return URGENCY.HIGH;
  if (runwayDays <= mediumMaxDays) return URGENCY.MEDIUM;
  return URGENCY.LOW;
}

function assertCurvesMatch(curves, cfg) {
  if (curves?.schemaVersion !== SCHEMA_VERSION || typeof curves.products !== "object") {
    throw new TypeError("curves must come from buildBenchmarkCurves (schemaVersion mismatch)");
  }
  if (curves.horizonDays !== cfg.horizonDays) {
    throw new RangeError(`curves were built for a ${curves.horizonDays}-day horizon but options say ${cfg.horizonDays}`);
  }
}
