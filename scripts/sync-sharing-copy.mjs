// Run from the project folder:  node scripts/sync-sharing-copy.mjs
// Copies the Extended-models wording from lib/dataUse.js (the one source of truth) into the fallback block inside
// public/miniapp/index.html. The page shows that fallback until the server's copy arrives, and keeps it if the server can't be
// reached, so the Details button always has something to show. Run it whenever DATA_SHARING_COPY changes;
// tests/dataSharing.test.mjs fails if the two ever differ. Add --check to only compare.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DATA_SHARING_COPY } from "../lib/dataUse.js";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "miniapp", "index.html");
const html = fs.readFileSync(file, "utf8");
const re = /(\/\/ BEGIN SHARING_COPY_FALLBACK[^\n]*\n)\s*const SHARING_COPY_FALLBACK = [\s\S]*?;\n(\s*\/\/ END SHARING_COPY_FALLBACK)/;
if (!re.test(html)) { console.error("markers not found in index.html"); process.exit(1); }
const next = html.replace(re, (_, a, b) => `${a}  const SHARING_COPY_FALLBACK = ${JSON.stringify(DATA_SHARING_COPY, null, 2).replace(/\n/g, "\n  ")};\n${b}`);
if (process.argv.includes("--check")) { console.log(next === html ? "in sync" : "OUT OF SYNC"); process.exit(next === html ? 0 : 1); }
fs.writeFileSync(file, next);
console.log(next === html ? "already in sync" : "updated public/miniapp/index.html");
