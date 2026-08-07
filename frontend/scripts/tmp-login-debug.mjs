/* TEMPORARY. Why does the browser login not navigate? */
import { chromium } from "playwright";

let browser;
for (let i = 0; i < 5; i++) {
  try {
    browser = await chromium.launch();
    break;
  } catch (e) {
    console.log(`launch attempt ${i + 1} failed: ${e.message.split("\n")[0]}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}
const page = await browser.newPage();
page.on("console", (m) => console.log(`console.${m.type()}: ${m.text().slice(0, 200)}`));
page.on("pageerror", (e) => console.log(`pageerror: ${e.message.slice(0, 200)}`));
page.on("requestfailed", (r) => console.log(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.url().includes("/api/")) console.log(`api: ${r.status()} ${r.url()}`);
});
await page.goto("http://127.0.0.1:3000/login", { waitUntil: "domcontentloaded" });
console.log("url after goto:", page.url());
await page.fill('input[type="email"]', "trile0104@gmail.com");
await page.fill('input[type="password"]', "tvm-temp-2026");
await page.click('button[type="submit"]');
await page.waitForTimeout(6000);
console.log("url after submit:", page.url());
console.log("visible text:", (await page.locator("body").innerText()).slice(0, 400).replace(/\n+/g, " | "));
await page.screenshot({ path: "C:\\Users\\tril\\Projects\\po-calendar\\frontend\\tmp-login-debug.png" });
await browser.close();
