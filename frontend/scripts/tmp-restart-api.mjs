/* TEMPORARY. Restart the FastAPI dev server (the shell here cannot call python directly). */
import { execSync, spawn } from "node:child_process";
import { openSync } from "node:fs";

const root = "C:\\Users\\tril\\Projects\\po-calendar\\backend";
for (let pass = 0; pass < 4; pass++) {
  let pids = new Set();
  try {
    const out = execSync("netstat -ano -p tcp | findstr :8000", { encoding: "utf8" });
    pids = new Set(
      out.split("\n").filter((l) => l.includes("LISTENING")).map((l) => l.trim().split(/\s+/).pop()),
    );
  } catch {
    /* findstr exits 1 when nothing matches */
  }
  if (!pids.size) {
    console.log("port 8000 clear");
    break;
  }
  for (const pid of pids) {
    try {
      console.log(execSync(`taskkill /PID ${pid} /F /T`, { encoding: "utf8" }).trim());
    } catch (e) {
      console.log(`pid ${pid}: ${((e.stdout ?? "") + (e.stderr ?? "")).trim()}`);
      try {
        console.log(
          execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force"`, {
            encoding: "utf8",
          }).trim() || `pid ${pid} stopped via Stop-Process`,
        );
      } catch (e2) {
        console.log(`pid ${pid} survived: ${((e2.stdout ?? "") + (e2.stderr ?? "")).trim()}`);
      }
    }
  }
  execSync("powershell -NoProfile -Command \"Start-Sleep -Milliseconds 700\"");
}

const log = openSync("C:\\Users\\tril\\AppData\\Local\\Temp\\po-api.log", "a");
const child = spawn(
  `${root}\\.venv\\Scripts\\python.exe`,
  ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--reload"],
  { cwd: root, detached: true, stdio: ["ignore", log, log] },
);
child.unref();
console.log(`uvicorn starting, pid ${child.pid}`);
