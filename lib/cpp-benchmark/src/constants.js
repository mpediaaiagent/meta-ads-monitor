// Every string the output can contain. The dashboard will switch on these, so they are part of
// the output contract: add values freely, but renaming one is a breaking change (bump
// SCHEMA_VERSION and say so in the README).

/** Bumped whenever a field is renamed/removed or an enum value changes meaning. */
export const SCHEMA_VERSION = 1;

/** Whether a day was judged at all. Only "evaluated" days carry a position/trajectory. */
export const STATUS = Object.freeze({
  EVALUATED: "evaluated",
  INSUFFICIENT_DATA: "insufficient_data",
  BEYOND_BENCHMARK_WINDOW: "beyond_benchmark_window",
});

export const POSITION = Object.freeze({
  INSIDE: "inside",
  NEAR_EDGE: "near_edge",
  OUTSIDE: "outside",
});

export const TRAJECTORY = Object.freeze({
  IMPROVING: "improving",
  FLAT: "flat",
  WORSENING: "worsening",
  /** No earlier post-floor day inside the lookback window to compare against. */
  UNKNOWN: "unknown",
});

export const CONFIDENCE = Object.freeze({
  OK: "ok",
  LOW: "low",
});

export const REMARK = Object.freeze({
  SCALE_CANDIDATE: "scale_candidate",
  HOLD_WATCH: "hold_watch",
  HOLD: "hold",
  REDUCE_SPEND: "reduce_spend",
  WAIT_ONE_MORE_DAY: "wait_one_more_day",
  PAUSE_CANDIDATE: "pause_candidate",
  /** Forced whenever the benchmark for that product/day is low confidence. */
  HOLD_MONITOR: "hold_monitor",
  // Not verdicts: mirrored from STATUS so a consumer reading only `remark` never sees one.
  INSUFFICIENT_DATA: STATUS.INSUFFICIENT_DATA,
  BEYOND_BENCHMARK_WINDOW: STATUS.BEYOND_BENCHMARK_WINDOW,
});

/** Only set on reduce_spend, and rises as runway shrinks. */
export const URGENCY = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});
