// Every string the output can contain. The dashboard switches on these, so they are part of the
// output contract: add values freely, but renaming one is a breaking change (bump SCHEMA_VERSION).

/** Bumped whenever a field is renamed/removed or an enum value changes meaning. */
export const SCHEMA_VERSION = 3;

/** Same words the adset-level Advise column uses. */
export const VERDICT = Object.freeze({
  KEEP: "Keep",
  PAUSE: "Pause",
});

/** Why a day got its verdict. */
export const REASON = Object.freeze({
  /** Has purchases; cumulative CPP is above that day's benchmark + margin. */
  CPP_ABOVE_BENCHMARK: "cpp_above_benchmark",
  /** Has purchases; cumulative CPP is at or under that day's benchmark + margin. */
  WITHIN_CPP_BENCHMARK: "within_cpp_benchmark",
  /** No purchase yet; has spent more than any successful ad spent before its first purchase. */
  SPEND_WITHOUT_PURCHASE: "spend_without_purchase",
  /** No purchase yet; spend is still within the first-purchase limit. */
  WITHIN_FIRST_PURCHASE_LIMIT: "within_first_purchase_limit",
  /** Past incubation; CPP over the 10-day window is above the product's threshold. */
  WINDOW_CPP_ABOVE_THRESHOLD: "window_cpp_above_threshold",
  /** Past incubation; CPP over the 10-day window is at or under the product's threshold. */
  WITHIN_WINDOW_THRESHOLD: "within_window_threshold",
  /** Nothing to compare against (no successful ad of this product had data for this case). Defaults to Keep. */
  NO_BENCHMARK: "no_benchmark",
});

/** Where an ad is in its life, from the point of view of this rule. */
export const STATUS = Object.freeze({
  /** Days 1..incubationMaxDay — judged day by day against the benchmark. */
  INCUBATION: "incubation",
  /** Older than the incubation window — judged on its 10-day window against the product threshold (judgeWindow). */
  PAST_INCUBATION: "past_incubation",
  /** Never spent anything yet. */
  NOT_STARTED: "not_started",
});

/** Which benchmark a day was compared with. */
export const BENCHMARK_KIND = Object.freeze({
  CPP: "cpp",
  FIRST_PURCHASE_LIMIT: "first_purchase_limit",
  WINDOW_THRESHOLD: "window_threshold",
});

/** What an ad's current verdict was based on. */
export const BASIS = Object.freeze({
  /** Its latest incubation day, against that day's benchmark. */
  INCUBATION: "incubation",
  /** Its totals over the 10-day window, against the product threshold (ads past incubation). */
  WINDOW: "window",
});
