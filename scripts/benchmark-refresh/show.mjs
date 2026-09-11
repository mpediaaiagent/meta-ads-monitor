// Step 4a: print the exact ads_get_ad_entities parameters for one or more planned calls.
//
//   node show.mjs tb_0 tb_1a

import path from "node:path";
import { args, readJson, workDir } from "./common.mjs";

const plan = readJson(path.join(workDir(), "plan.json"));
for (const key of args().rest) {
  const b = plan.find((x) => x.key === key);
  if (!b) {
    console.log(`UNKNOWN KEY ${key}`);
    continue;
  }
  console.log(`KEY ${key}: ad_account_id="${b.accountId}" time_range='{"since":"${b.since}","until":"${b.until}"}' expected_rows=${b.expected}`);
  console.log("ids: " + JSON.stringify(b.ids));
}
