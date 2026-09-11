// Ceiling statistics for the benchmark curve. A statistic is any `{ name, compute(values) }`: the
// curve builder only ever calls compute(), so moving from max to a trimmed percentile is a config
// change — `ceilingStatistic: STATISTICS.percentile(80)` — not a code change.

/** The highest CPP in the sample: the most lenient ceiling, and the most outlier-sensitive. */
const max = Object.freeze({
  name: "max",
  compute(values) {
    assertSample(values);
    return Math.max(...values);
  },
});

/**
 * The p-th percentile (0–100), interpolating linearly between the closest ranks. This is the same
 * method as Excel's PERCENTILE.INC and numpy's default, so a ceiling can be cross-checked in the
 * Sheet by hand.
 */
function percentile(p) {
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new RangeError(`percentile must be between 0 and 100, got ${p}`);
  }
  return Object.freeze({
    name: `p${p}`,
    compute(values) {
      assertSample(values);
      const sorted = [...values].sort((a, b) => a - b);
      const rank = (p / 100) * (sorted.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
    },
  });
}

function assertSample(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("a ceiling statistic needs at least one value");
  }
}

export const STATISTICS = Object.freeze({ max, percentile });

export function isStatistic(s) {
  return s != null && typeof s.name === "string" && typeof s.compute === "function";
}
