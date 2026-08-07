/* TEMPORARY. Bump db.py's mtime (content unchanged) and watch for the reloader. */
import { readFileSync, writeFileSync } from "node:fs";

const LOG = `${process.env.TEMP}\\po-api.log`;
const target = "C:\\Users\\tril\\Projects\\po-calendar\\backend\\app\\db.py";
const before = readFileSync(LOG, "utf8").length;
writeFileSync(target, readFileSync(target));
console.log("mtime bumped, waiting for the reloader…");
await new Promise((r) => setTimeout(r, 6000));
const tail = readFileSync(LOG, "utf8").slice(before);
console.log(tail.trim() || "(reloader said nothing — it is not watching these files)");
