// Which planned calls still need a verified result.
//
//   node status.mjs

import fs from "node:fs";
import path from "node:path";
import { readJson, workDir } from "./common.mjs";

const dir = workDir();
const plan = readJson(path.join(dir, "plan.json"));
const todo = plan.filter((b) => !fs.existsSync(path.join(dir, "state", `${b.key}.json`))).map((b) => b.key);
console.log(`done ${plan.length - todo.length} of ${plan.length}`);
console.log(`TODO: ${todo.join(" ") || "none"}`);
