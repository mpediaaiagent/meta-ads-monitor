import { VERDICT } from "./constants.js";

/** Statuses meaning the ad is already switched off in Meta. */
const OFF = /PAUSED|DELETED|ARCHIVED/i;

/** Is the ad still running in Meta? Unknown status counts as running. */
export function isRunning(status) {
  return !OFF.test(String(status ?? ""));
}

/**
 * The adset's Advise, from its ads' own verdicts: Pause if at least one running ad is Pause,
 * Keep if every running ad with a verdict is Keep, null when no running ad has a verdict.
 *
 * Ads already paused in Meta don't count — an ad you have already switched off shouldn't make
 * the whole adset read Pause.
 *
 * @param {{verdict: "Keep"|"Pause"|null, status?: string}[]} ads
 * @returns {{verdict: "Keep"|"Pause"|null, counted: number, pauseIndexes: number[], ignoredPaused: number}}
 */
export function rollUpAdset(ads) {
  let counted = 0;
  let ignoredPaused = 0;
  const pauseIndexes = [];
  ads.forEach((ad, i) => {
    if (!ad || !ad.verdict) return;
    if (!isRunning(ad.status)) {
      ignoredPaused++;
      return;
    }
    counted++;
    if (ad.verdict === VERDICT.PAUSE) pauseIndexes.push(i);
  });
  const verdict = counted === 0 ? null : pauseIndexes.length ? VERDICT.PAUSE : VERDICT.KEEP;
  return { verdict, counted, pauseIndexes, ignoredPaused };
}
