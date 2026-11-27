// Takes the CI screenshots (evidence.yml): every page in EVIDENCE_PATHS, at a
// phone and a desktop viewport, in light and dark colour schemes, from the
// base branch's app (BEFORE_URL, skipped if it does not start) and the pull
// request's app (AFTER_URL). Writes before-*.png / after-*.png to OUT_DIR.
// Runs with the pull request's code and a read-only token; the trusted
// evidence-publish.yml validates and posts the files.
const fs = require("node:fs");
const path = require("node:path");

const { PLAYWRIGHT_DIR, BEFORE_URL, AFTER_URL, OUT_DIR, EVIDENCE_PATHS = "/" } = process.env;
const { chromium } = require(path.join(PLAYWRIGHT_DIR, "node_modules", "playwright"));

const VIEWPORTS = { mobile: { width: 375, height: 812 }, desktop: { width: 1280, height: 800 } };
const SCHEMES = ["light", "dark"];
const slug = (p) => p.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "home";

async function up(url) {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(url)).status < 500) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const pages = EVIDENCE_PATHS.split(",").map((p) => p.trim()).filter(Boolean);
  for (const [side, base] of [["before", BEFORE_URL], ["after", AFTER_URL]]) {
    if (!(await up(base))) {
      console.log(`${side}: ${base} did not start; no ${side} screenshots`);
      if (side === "after") process.exitCode = 1;
      continue;
    }
    for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
      for (const colorScheme of SCHEMES) {
        const context = await browser.newContext({ viewport, colorScheme });
        const page = await context.newPage();
        for (const p of pages) {
          const file = path.join(OUT_DIR, `${side}-${vp}-${colorScheme}-${slug(p)}.png`);
          await page.goto(new URL(p, base).href, { waitUntil: "networkidle" });
          await page.screenshot({ path: file, fullPage: true });
          console.log(`wrote ${path.basename(file)}`);
        }
        await context.close();
      }
    }
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
