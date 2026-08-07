/* TEMPORARY. The uvicorn serving :8000 was started by an IDE terminal yesterday and
   lives outside this shell's process namespace, so it cannot be restarted from here
   and is still running pre-change code. Run a second server on :8001 from today's
   tree; the Playwright checks route the browser at it.                            */
import { execSync, spawn } from "node:child_process";
import { openSync } from "node:fs";

const root = "C:\\Users\\tril\\Projects\\po-calendar\\backend";
const LOG = "C:\\Users\\tril\\AppData\\Local\\Temp\\po-api-8001.log";

try {
  const out = execSync("netstat -ano -p tcp | findstr :8001", { encoding: "utf8" });
  for (const pid of new Set(
    out.split("\n").filter((l) => l.includes("LISTENING")).map((l) => l.trim().split(/\s+/).pop()),
  )) {
    try {
      execSync(`taskkill /PID ${pid} /F /T`, { encoding: "utf8" });
    } catch {
      /* not visible from here */
    }
  }
} catch {
  /* nothing on 8001 */
}

const child = spawn(
  `${root}\\.venv\\Scripts\\python.exe`,
  ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"],
  { cwd: root, detached: true, stdio: ["ignore", openSync(LOG, "a"), openSync(LOG, "a")] },
);
child.unref();

for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch("http://127.0.0.1:8001/api/auth/config");
    if (res.ok) {
      console.log(`:8001 up (pid ${child.pid}) → ${await res.text()}`);
      process.exit(0);
    }
  } catch {
    /* still starting */
  }
}
console.log(`:8001 did not come up; see ${LOG}`);
process.exit(1);
