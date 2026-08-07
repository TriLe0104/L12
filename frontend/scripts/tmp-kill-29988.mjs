/* TEMPORARY. The API is served by the uvicorn an IDE terminal started yesterday
   (terminal 2746, pid 29988). Try to stop it so a fresh one picks up today's code. */
import { execSync } from "node:child_process";

const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim() || "(ok)";
  } catch (e) {
    return `FAILED: ${((e.stdout ?? "") + (e.stderr ?? "")).trim().split("\n")[0]}`;
  }
};
console.log("tree of 29988:", run('powershell -NoProfile -Command "Get-Process -Id 29988 | Format-List Id,Name,Path"'));
console.log("taskkill 29988:", run("taskkill /PID 29988 /F /T"));
console.log("all python by name:", run("taskkill /IM python.exe /F /T"));
await new Promise((r) => setTimeout(r, 2000));
try {
  const res = await fetch("http://127.0.0.1:8000/api/auth/config");
  console.log(`:8000 still answers → ${res.status}`);
} catch (e) {
  console.log(`:8000 refused (${e.cause?.code ?? e.message}) — port is now free`);
}
