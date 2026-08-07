/* TEMPORARY. List/kill the uvicorn processes by command line, since netstat's PIDs
   are not resolvable from this shell's network namespace.                        */
import { execSync } from "node:child_process";

const q =
  'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | Select-Object ProcessId,CreationDate,CommandLine | Format-List"';
const list = execSync(q, { encoding: "utf8" });
console.log(list.trim() || "no python.exe running");

if (process.argv[2] === "kill") {
  const keep = process.argv.slice(3);
  const pids = [...list.matchAll(/ProcessId\s*:\s*(\d+)/g)].map((m) => m[1]).filter((p) => !keep.includes(p));
  for (const pid of pids) {
    try {
      console.log(execSync(`taskkill /PID ${pid} /F /T`, { encoding: "utf8" }).trim());
    } catch (e) {
      console.log(`pid ${pid}: ${((e.stdout ?? "") + (e.stderr ?? "")).trim().split("\n")[0]}`);
    }
  }
}
