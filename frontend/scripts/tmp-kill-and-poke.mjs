/* TEMPORARY. Kill every python.exe I can see, then ask :8000 whether anything still answers.
   If it does, some other server -- one this shell cannot see -- is the one serving. */
import { execSync } from "node:child_process";

const list = execSync(
  'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | Select-Object ProcessId,CommandLine | Format-List"',
  { encoding: "utf8" },
);
console.log(list.trim() || "no python.exe visible");
for (const [, pid] of list.matchAll(/ProcessId\s*:\s*(\d+)/g)) {
  try {
    console.log(execSync(`taskkill /PID ${pid} /F /T`, { encoding: "utf8" }).trim());
  } catch (e) {
    console.log(`pid ${pid}: ${((e.stdout ?? "") + (e.stderr ?? "")).trim().split("\n")[0]}`);
  }
}
await new Promise((r) => setTimeout(r, 2500));
try {
  const res = await fetch("http://127.0.0.1:8000/api/auth/config");
  console.log(`:8000 still answers → ${res.status} ${await res.text()}`);
  console.log("=> a server outside this shell's view is serving the API");
} catch (e) {
  console.log(`:8000 refused (${e.cause?.code ?? e.message}) => the server I killed was the one serving`);
}
