// Step 4b: check and keep one call's saved result.
//
//   node rec.mjs tb_0=<saved result file>
//
// OK only when the row count is exactly ads × days and every requested ad id is present.
// Anything else is a truncated or mistyped call and must be refetched.

import fs from "node:fs";
import path from "node:path";
import { args, loadMetaResult, readJson, workDir, writeJson } from "./common.mjs";

const dir = workDir();
const plan = readJson(path.join(dir, "plan.json"));
for (const a of args().rest) {
  const key = a.slice(0, a.indexOf("="));
  const file = a.slice(a.indexOf("=") + 1);
  const b = plan.find((x) => x.key === key);
  if (!b) {
    console.log(`UNKNOWN KEY ${key}`);
    continue;
  }
  const { rows } = loadMetaResult(file);
  const got = new Set(rows.map((r) => r.id));
  const missing = b.ids.filter((id) => !got.has(id));
  const ok = rows.length === b.expected && missing.length === 0;
  if (ok) {
    fs.writeFileSync(path.join(dir, "pages", `${key}.json`), JSON.stringify(rows));
    writeJson(path.join(dir, "state", `${key}.json`), { rows: rows.length });
  }
  console.log(`${ok ? "OK" : "MISMATCH"} ${key} rows=${rows.length} expected=${b.expected} missing_ids=${missing.length ? missing.join(",") : 0}`);
}
