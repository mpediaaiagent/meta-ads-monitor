// Public entry point. See ../README.md for the rules, the input and the output.

export { buildBenchmarks, buildAdsetBenchmarks, dayCeilings, spendBeforeFirstPurchase, firstPurchaseDay, cppOnDay, meetsThreshold } from "./benchmark.js";
export { evaluateAd, judgeDay, judgeWindow } from "./evaluate.js";
export { rollUpAdset, isRunning, adsetFirstPurchase, adsetCpp, adsetSpendBeforeFirstPurchase } from "./adset.js";
export { alignFromFirstSpend, classifyProduct, isSuccessful, InputError } from "./history.js";
export { DEFAULT_CONFIG, DEFAULT_PRODUCTS, resolveConfig, describeConfig } from "./config.js";
export { STATISTICS } from "./statistics.js";
export { SCHEMA_VERSION, VERDICT, REASON, STATUS, BENCHMARK_KIND, BASIS } from "./constants.js";
