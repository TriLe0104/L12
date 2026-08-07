/* TEMPORARY. Is the server my node scripts talk to the same process writing my log? */
import { readFileSync } from "node:fs";

const LOG = `${process.env.TEMP}\\po-api.log`;
const before = readFileSync(LOG, "utf8").length;
const res = await fetch("http://127.0.0.1:8000/api/auth/config");
const marker = await res.text();
await new Promise((r) => setTimeout(r, 1200));
const after = readFileSync(LOG, "utf8");
console.log(`GET /api/auth/config → ${res.status} ${marker.slice(0, 60)}`);
console.log(`log grew: ${after.length > before}`);
console.log(after.slice(before).trim() || "(no new log lines — a different process answered)");
