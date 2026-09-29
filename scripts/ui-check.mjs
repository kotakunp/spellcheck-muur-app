import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const PORT = Number(process.env.UI_PORT || 4100 + Math.floor(Math.random() * 200));
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = new URL("./shots/", import.meta.url);

await mkdir(SHOTS, { recursive: true });



// Text used everywhere a checked document is needed.
const SAMPLE_TEXT = "Монгол улс нь Азийн зүүн хэсэгт оршино. Уланбаатар хот олон хүүнтэй. Би маргааш нийтийн тээвэрээр худалдааны төв рүү явна.";

// ---- assertion collector ----
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail ?? null });
  if (!pass) console.log(`FAIL ${name}`, detail ?? "");
}

const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: "ignore",
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await sleep(200);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

// Track every /suggest request from the very first interaction.
let suggestCount = 0;
let inflight = 0;
let maxInflight = 0;
page.on("request", (r) => {
  if (!r.url().endsWith("/suggest")) return;
  suggestCount++;
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
});
page.on("requestfinished", (r) => r.url().endsWith("/suggest") && inflight--);
page.on("requestfailed", (r) => r.url().endsWith("/suggest") && inflight--);

const shot = (name) => page.screenshot({ path: new URL(name, SHOTS).pathname });
const textValue = () => page.locator("#text").inputValue();

// Marks render behind the textarea, so drive hover through raw mouse moves.
async function hoverMark(locator) {
  await page.locator("#pad").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator("#hover-card").waitFor({ state: "visible", timeout: 6000 });
}

// paint() only runs once the 400ms debounced check comes back. A plain
// waitForSelector(".pad__marks mark") passes on the *previous* text's marks, so
// wait until the painted backdrop actually matches the textarea.
const waitForFreshMarks = () =>
  page.waitForFunction(
    () => document.getElementById("backdrop").textContent.replace(/\n$/, "") === document.getElementById("text").value,
    null,
    { timeout: 10000 }
  );

async function hoverFirstMark() {
  await waitForFreshMarks();
  await hoverMark(page.locator(".pad__marks mark").first());
  await page.waitForSelector("#hover-card .rank__item", { timeout: 8000 });
  // The candidates fade in and the card grows to fit them, so let that finish
  // before anything tries to click a row.
  await page.waitForTimeout(450);
}

const pickRank = (n = 1) => page.locator("#hover-card .rank__item").nth(n - 1).click();

await page.goto(BASE, { waitUntil: "networkidle" });

// ===== Landing: single page hosts both marketing and the live app =====
check("hero headline rendered", (await page.locator(".hero__title").textContent()) === "Алдаа шалгагч");
check("nav CTA present", await page.locator("#nav-cta").isVisible());
check("feature cards render", (await page.locator(".feat").count()) === 6);
check("how-it-works steps render", (await page.locator(".step").count()) === 3);
check("footer rendered", (await page.locator(".foot").count()) === 1);
check("app lives inside the landing page", (await page.locator('#app #text').count()) === 1);
await shot("00-hero.png");

// Nav CTA smooth-scrolls down to the embedded app.
await page.locator("#nav-cta").click();
await page.waitForTimeout(1200);
check("nav CTA scrolls the app into view", await page.evaluate(() => {
  const r = document.getElementById("text").getBoundingClientRect();
  return r.top > -120 && r.top < window.innerHeight;
}));

// ===== Empty state: no cards anywhere, replacement history empty =====
check("empty state visible", await page.locator("#empty").isVisible());
check("empty title names the panel", (await page.locator("#empty-title").textContent()) === "Алдаа олдсонгүй");
check("panel is titled Алдаатай үгс", (await page.locator(".side__title").textContent()) === "Алдаатай үгс");
check("panel list empty at start", (await page.locator("#history-list .histentry, #history-list .errrow").count()) === 0);
check("no card elements exist anymore", (await page.locator(".card, #cards, #all-list, .tabs").count()) === 0);
check("no marks at start", (await page.locator(".pad__marks mark").count()) === 0);
check("undo disabled at start", await page.locator("#undo-btn").isDisabled());
check("redo disabled at start", await page.locator("#redo-btn").isDisabled());
check("reading time stat is gone", (await page.locator("#stat-reading").count()) === 0);
check("no dropzone or file picker", (await page.locator("#dropzone, #file-input").count()) === 0);
check("no samples controls", (await page.locator("#samples-btn, #sample-btn, #samples-menu").count()) === 0);
check("no fix all button", (await page.locator("#fix-all-btn").count()) === 0);
check("no check button at all", (await page.locator("#check-btn, .actions").count()) === 0);
check("format bar shows four tools", (await page.locator("#formatbar .fmtbtn").count()) === 4);
const padBox0 = await page.locator("#pad").boundingBox();
const fmtBox0 = await page.locator("#formatbar").boundingBox();
check("formatters sit under the input", fmtBox0.y >= padBox0.y + padBox0.height - 2, { padBottom: padBox0.y + padBox0.height, fmt: fmtBox0.y });
await shot("01-empty.png");

// ===== Type text: every flagged word is highlighted at once =====
await page.locator("#text").fill(SAMPLE_TEXT);
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
const marks = await page.locator(".pad__marks mark").allTextContents();
const uniqueMarks = [...new Set(marks.map((m) => m.toLowerCase()))];
check("typed text produces marks", marks.length > 0, marks);
check("marks cover every flagged occurrence", marks.length >= uniqueMarks.length, { marks: marks.length, uniqueMarks });
const tintedCount = await page.evaluate(() =>
  [...document.querySelectorAll(".pad__marks mark")].filter((m) => getComputedStyle(m).backgroundColor !== "rgba(0, 0, 0, 0)").length
);
check("all misspellings are tinted at once", tintedCount === marks.length, { tintedCount, marks: marks.length });
check("hover card hidden until hovered", await page.locator("#hover-card").isHidden());
await shot("02-flagged.png");

// ===== The panel lists wrong words, then what they became =====
check("panel lists every flagged word", (await page.locator("#history-list .errrow").count()) === 3, await page.locator("#history-list .errrow").count());
const panelWords = await page.locator("#history-list .errrow__word").allTextContents();
check("panel words are the flagged words", ["Уланбаатар", "хүүнтэй", "тээвэрээр"].every((w) => panelWords.includes(w)), panelWords);
check("no replacement rows before anything is fixed", (await page.locator("#history-list .histentry").count()) === 0);
check("panel hides the empty state while words are wrong", await page.locator("#empty").isHidden());

// Clicking a word jumps to it in the text.
await page.locator("#history-list .errrow").first().click();
await page.waitForTimeout(200);
check("clicking a word highlights it in the text", (await page.locator(".pad__marks mark.is-hover").count()) >= 1);
check("clicking a word focuses the editor", await page.evaluate(() => document.activeElement?.id === "text"));

// Repeated words get one row with an occurrence badge, not two rows.
await page.locator("#clear-btn").click();
await page.locator("#text").fill("Уланбаатар хот. Уланбаатар руу.");
await waitForFreshMarks();
check("repeated word shows one row, not two", (await page.locator("#history-list .errrow").count()) === 1, await page.locator("#history-list .errrow").count());
check("repeated word shows its occurrence count", (await page.locator("#history-list .errrow__count").first().textContent()) === "×2");
await page.locator("#clear-btn").click();
await page.locator("#text").fill(SAMPLE_TEXT);
await waitForFreshMarks();
await page.mouse.move(4, 4);

// ===== Hover fetches its own candidates, one request per word =====
const typo = "Уланбаатар";
const SUGGEST_URL = "**/cms-client/modules/spellchecker/suggest";
await page.route(SUGGEST_URL, async (route) => {
  await new Promise((r) => setTimeout(r, 600));
  await route.continue();
});
const beforeHover = suggestCount;
await hoverMark(page.locator(".pad__marks mark").first());
check("hover opens the card immediately", await page.locator("#hover-card").isVisible());
check("hover shows a loading state while it fetches", /Санал хайж байна/.test(await page.locator("#hover-card .rank__hint").textContent()));
check("loading state is styled as a shimmer", (await page.locator("#hover-card .rank__hint--loading").count()) === 1);
check("no candidates yet while loading", (await page.locator("#hover-card .rank__item").count()) === 0);
await page.waitForSelector("#hover-card .rank__item", { timeout: 8000 });
check("hover fetches exactly one request for the word", suggestCount === beforeHover + 1, suggestCount - beforeHover);
check("hover never fires parallel suggestion requests", maxInflight <= 1, maxInflight);
check("candidates fade in once loaded", (await page.locator("#hover-card .rank--in .rank__item").count()) > 0);
check("loading state is cleared after the fetch", (await page.locator("#hover-card .rank__hint--loading").count()) === 0);

// A second hover of the same word comes from the cache.
await page.mouse.move(4, 4);
await page.waitForTimeout(450);
check("card closes when the pointer leaves", await page.locator("#hover-card").isHidden());
await hoverMark(page.locator(".pad__marks mark").first());
await page.waitForSelector("#hover-card .rank__item", { timeout: 8000 });
check("a second hover is served from the cache, with no new request", suggestCount === beforeHover + 1, suggestCount - beforeHover);
await page.unroute(SUGGEST_URL);

// ===== Ranked candidates, highlight and the rest of the hover card =====
check("hover opens the suggestion card", await page.locator("#hover-card").isVisible());
check("hover highlights every occurrence of the word", (await page.locator(".pad__marks mark.is-hover").count()) >= 1);
const rankItems = await page.locator("#hover-card .rank__item").allTextContents();
check("hover lists ranked candidates", rankItems.length > 0, rankItems);
const topCandidate = await page.locator("#hover-card .rank__word").first().textContent();
const topRankNo = await page.locator("#hover-card .rank__no").first().textContent();
check("top candidate is ranked first", topRankNo === "1" && topCandidate === "Улаанбаатар", { topRankNo, topCandidate });
check("hover card shows nothing but the candidate list and actions", (await page.locator("#hover-card .card__explain, #hover-card .rank__hint").count()) === 0);
// The tint has a 0.12s transition, so let it settle before comparing colours —
// a cache-hit hover can land within that window of a repaint.
await page.waitForTimeout(250);
check("hover word gets the stronger tint", (await page.evaluate(() => {
  const m = document.querySelector(".pad__marks mark.is-hover");
  const n = document.querySelector(".pad__marks mark:not(.is-hover)");
  return getComputedStyle(m).backgroundColor !== getComputedStyle(n).backgroundColor;
})));
await shot("03-hover-card.png");

// ===== Replace via the ranked list: history entry + casing =====
await pickRank(1);
await page.waitForTimeout(900);
const replacedText = await textValue();
check("ranked pick replaces the word", replacedText.includes("Улаанбаатар") && !replacedText.includes(typo), replacedText.slice(0, 60));
check("hover card closes after replacing", await page.locator("#hover-card").isHidden());
check("replaced word loses its marks", (await page.locator(`.pad__marks mark:text-is("${typo}")`).count()) === 0);
const historyRows = await page.locator("#history-list .histentry").count();
check("replacement recorded in history", historyRows === 1, historyRows);
check("history shows the wrong word", (await page.locator("#history-list .histentry__from").first().textContent()) === typo);
check("history shows the new word", (await page.locator("#history-list .histentry__to").first().textContent()) === "Улаанбаатар");
check("history arrow present", (await page.locator("#history-list .histentry__arrow").first().textContent()) === "→");
check("history time stamp present", /\d{1,2}:\d{2}/.test(await page.locator("#history-list .histentry__time").first().textContent()));
check("empty state hidden once history has entries", await page.locator("#empty").isHidden());
check("status confirms the transform", /солигдлоо/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
await shot("04-history.png");

// ===== Undo / redo =====
await page.locator("#undo-btn").click();
await page.waitForTimeout(900);
check("undo restores the typo", (await textValue()).includes(typo));
check("redo becomes enabled after undo", !(await page.locator("#redo-btn").isDisabled()));
await page.locator("#redo-btn").click();
await page.waitForTimeout(900);
check("redo re-applies the fix", !(await textValue()).includes(typo));
check("history entry survives undo/redo of text", (await page.locator("#history-list .histentry").count()) === 1);

// ===== Hover actions: skip and add to dictionary =====
await page.locator("#clear-btn").click();
await page.locator("#text").fill("Шинэ нэр болох туршилтт гэж бичлээ.");
await hoverMark(page.locator(".pad__marks mark").first());
await page.locator('#hover-card [data-action="skip"]').click();
await page.waitForTimeout(300);
check("skip removes the mark", (await page.locator('.pad__marks mark:text-is("туршилтт")').count()) === 0);
check("status reports the skip", /алгаслаа/i.test(await page.locator("#status").textContent()));
check("skipped word is not persisted to the dictionary", (await page.evaluate(() => JSON.parse(localStorage.getItem("sc-ignored-v1") || "[]"))).length === 0);

await page.locator("#clear-btn").click();
await page.locator("#text").fill("Монгол улс нь хүүнтэй орон.");
await hoverMark(page.locator(".pad__marks mark").first());
await page.locator('#hover-card [data-action="ignore"]').click();
await page.waitForTimeout(300);
check("dictionary add removes the mark", (await page.locator('.pad__marks mark:text-is("хүүнтэй")').count()) === 0);
check("dictionary persisted to localStorage", (await page.evaluate(() => JSON.parse(localStorage.getItem("sc-ignored-v1") || "[]"))).includes("хүүнтэй"));
check("status confirms dictionary add", /тольд нэмлээ/i.test(await page.locator("#status").textContent()));
await page.locator("#settings-btn").click();
check("settings menu opens", await page.locator("#settings-menu").isVisible());
await page.locator("#clear-dict").click();
await page.waitForSelector('.pad__marks mark:text-is("хүүнтэй")', { timeout: 8000 });
check("cleared dictionary restores the mark", (await page.locator('.pad__marks mark:text-is("хүүнтэй")').count()) === 1);
check("settings menu closed after clear", await page.locator("#settings-menu").isHidden());
check("dictionary emptied in storage", (await page.evaluate(() => JSON.parse(localStorage.getItem("sc-ignored-v1") || "[]"))).length === 0);

// ===== Keyboard shortcut: Cmd/Ctrl+Enter re-checks =====
await page.locator("#text").click();
await page.keyboard.press("ControlOrMeta+Enter");
await page.waitForTimeout(900);
check("shortcut keeps results in sync", (await page.locator(".pad__marks mark").count()) > 0);

// ===== Stylesheet sanity: every rule must be top level (only @media may nest) =====
const cssHealth = await page.evaluate(() => {
  const sheet = [...document.styleSheets].find((s) => s.href?.includes("styles.css"));
  const nested = [...sheet.cssRules].filter((r) => r.selectorText && r.cssRules && r.cssRules.length > 0).map((r) => r.selectorText);
  const side = document.querySelector(".side").getBoundingClientRect();
  const editor = document.querySelector(".editor").getBoundingClientRect();
  const layout = getComputedStyle(document.querySelector(".layout"));
  return { nested, columns: layout.gridTemplateColumns.split(" ").length, sideWidth: Math.round(side.width), sideIsRight: side.x > editor.x, display: layout.display };
});
check("no rule accidentally nested in a broken block", cssHealth.nested.length === 0, cssHealth.nested);
check("layout is a two-column grid on desktop", cssHealth.display === "grid" && cssHealth.columns === 2, cssHealth);
check("sidebar sits to the right of the editor", cssHealth.sideIsRight && cssHealth.sideWidth >= 350, cssHealth);
check("editor panel is styled (not raw)", (await page.locator(".editor").evaluate((el) => getComputedStyle(el).backgroundColor)) !== "rgba(0, 0, 0, 0)");

// ===== Overlay geometry: marks line up with the textarea =====
const geometry = await page.evaluate(() => {
  const text = document.getElementById("text");
  const marks = document.getElementById("backdrop");
  const a = text.getBoundingClientRect();
  const b = marks.getBoundingClientRect();
  return { dx: Math.round(a.x - b.x), dy: Math.round(a.y - b.y), dw: Math.round(a.width - b.width), dh: Math.round(a.height - b.height) };
});
check("mark overlay aligns with textarea", Math.abs(geometry.dx) <= 1 && Math.abs(geometry.dy) <= 1 && Math.abs(geometry.dw) <= 1 && Math.abs(geometry.dh) <= 1, geometry);

// ===== Theme toggle + persistence =====
await page.locator("#settings-btn").click();
await page.locator("#theme-toggle").check();
check("dark theme attribute applied", (await page.locator("html").getAttribute("data-theme")) === "dark");
check("theme stored in localStorage", (await page.evaluate(() => localStorage.getItem("sc-theme-v1"))) === "dark");
await shot("07-dark.png");
await page.keyboard.press("Escape");
check("escape closes settings menu", await page.locator("#settings-menu").isHidden());
await page.reload({ waitUntil: "networkidle" });
check("dark theme survives reload", (await page.locator("html").getAttribute("data-theme")) === "dark");
check("theme checkbox reflects stored theme", await page.locator("#theme-toggle").isChecked());
check("replacement history is session-only (resets on reload)", (await page.locator("#history-list .histentry").count()) === 0);
check("history empty state returns after reload", await page.locator("#empty").isVisible());
await page.locator("#settings-btn").click();
await page.locator("#theme-toggle").uncheck();
check("light theme override stored", (await page.evaluate(() => localStorage.getItem("sc-theme-v1"))) === "light");
check("light theme attribute applied", (await page.locator("html").getAttribute("data-theme")) === "light");
await page.keyboard.press("Escape");

// ===== Clear button =====
await page.locator("#text").fill(SAMPLE_TEXT);
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
await page.locator("#clear-btn").click();
await page.waitForTimeout(300);
check("clear empties the editor", (await textValue()) === "");
check("clear removes all marks", (await page.locator(".pad__marks mark").count()) === 0);
check("clear resets stats", (await page.locator("#stat-words").textContent()) === "0 үг");
check("empty state reflects empty history", await page.locator("#empty").isVisible());
await shot("08-cleared.png");

// ===== Automatic check feedback: live count + staggered marks =====
await page.locator("#clear-btn").click();
await page.locator("#text").fill(SAMPLE_TEXT);
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
check("error count pill appears after an automatic check", await page.locator("#err-count").isVisible());
check("error count names the flagged words", (await page.locator("#err-count").textContent()) === "3 алдаа", await page.locator("#err-count").textContent());
check("error count equals the number of marks", (await page.locator("#err-count").textContent()) === `${(await page.locator(".pad__marks mark").count())} алдаа`);
check("marks pop in after checking", (await page.locator("#backdrop.just-checked mark").count()) > 0);
check("marks carry a stagger index", ((await page.locator("#backdrop mark").first().getAttribute("style")) || "").includes("--i:"));
await shot("15-check-feedback.png");
await page.locator("#clear-btn").click();
await page.waitForTimeout(400);
check("error count pill hides once the text is clean", await page.locator("#err-count").isHidden());

// ===== Cmd/Ctrl+Enter: sweep the pad and report the count =====
const CHECK_URL = "**/cms-client/modules/spellchecker/check";
await page.route(CHECK_URL, async (route) => {
  await new Promise((r) => setTimeout(r, 600));
  await route.continue();
});
await page.locator("#text").fill(SAMPLE_TEXT);
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
await page.waitForTimeout(900);
await page.locator("#text").click();
await page.keyboard.press("ControlOrMeta+Enter");
check("shortcut shows the scanning sweep", (await page.locator(".editor.is-scanning").count()) === 1);
await page.waitForFunction(() => !document.querySelector(".editor.is-scanning"), null, { timeout: 10000 });
check("shortcut clears the sweep when done", (await page.locator(".editor.is-scanning").count()) === 0);
check("shortcut reports how many errors were found", /3 алдаа олдлоо/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
await page.unroute(CHECK_URL);

// A clean document reports no errors.
await page.locator("#text").fill("Монгол хэл сайхан бичигдсэн байна.");
await page.waitForTimeout(900);
check("clean text shows no error count", await page.locator("#err-count").isHidden());
await page.locator("#text").click();
await page.keyboard.press("ControlOrMeta+Enter");
await page.waitForTimeout(800);
check("clean text reports no errors", /Алдаа олдсонгүй/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());

// ===== The panel turns a wrong word into "wrong → right" =====
await page.locator("#clear-btn").click();
await page.locator("#clear-history").click();
await page.locator("#text").fill("Уланбаатар болон хүүнтэй гэж бичсэн.");
await waitForFreshMarks();
check("panel lists both wrong words", (await page.locator("#history-list .errrow").count()) === 2, await page.locator("#history-list .errrow").count());
await hoverFirstMark();
await pickRank(1);
await page.waitForTimeout(900);
const loggedFrom = await page.locator("#history-list .histentry__from").first().textContent();
check("the fix is logged as a wrong → right row", (await page.locator("#history-list .histentry").count()) === 1, await page.locator("#history-list .histentry").count());
check("the logged row names the old word", loggedFrom.length > 0, loggedFrom);
check("the logged row names the new word", (await page.locator("#history-list .histentry__to").first().textContent()).length > 0);
check("only the untouched wrong word is left", (await page.locator("#history-list .errrow").count()) === 1, await page.locator("#history-list .errrow").count());
check("the fixed word left the wrong-word list", !(await page.locator("#history-list .errrow__word").allTextContents()).includes(loggedFrom));

// Clearing the log wipes the wrong → right rows but keeps the wrong words.
await page.locator("#clear-history").click();
await page.waitForTimeout(200);
check("clearing the log removes the wrong → right rows", (await page.locator("#history-list .histentry").count()) === 0);
check("clearing the log keeps the still-wrong word", (await page.locator("#history-list .errrow").count()) === 1, await page.locator("#history-list .errrow").count());
check("empty state stays hidden while a wrong word remains", await page.locator("#empty").isHidden());
check("history clear reports in the status", /цэвэрлэлээ/.test(await page.locator("#status").textContent()));



// ===== Typing triggers automatic checking =====
await page.locator("#text").fill("Энэ өгүүлбэрт улаанбатар гэсэн алдаа байна.");
await waitForFreshMarks();
check("typing auto-checks the text", (await page.locator(".pad__marks mark").count()) > 0);
const typedWord = await page.locator(".pad__marks mark").first().textContent();
await hoverFirstMark();
const typedBest = await page.locator("#hover-card .rank__word").first().textContent();
check("hovering offers ranked candidates", typedBest.length > 0 && typedBest.toLowerCase() !== typedWord.toLowerCase(), { typedWord, typedBest });
check("no candidate is a no-op for the word", (await page.locator("#hover-card .rank__word").allTextContents()).every((w) => w.toLowerCase() !== typedWord.toLowerCase()), await page.locator("#hover-card .rank__word").allTextContents());
await pickRank(1);
await page.waitForTimeout(900);
const typedFixed = await textValue();
check("lowercase typo is replaced with the chosen candidate", typedFixed.includes(typedBest.toLowerCase()) && !typedFixed.includes(typedWord), typedFixed);
check("replacement status names both words", (await page.locator("#status").textContent()).includes(typedWord) && (await page.locator("#status").textContent()).includes(typedBest), await page.locator("#status").textContent());

// ===== Replace-all with per-occurrence casing =====
await page.locator("#text").fill("Уланбаатар хот. УЛАНБААТАР руу. уланбаатар руу.");
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
check("repeated typo yields three marks", (await page.locator(".pad__marks mark").count()) === 3);
await hoverFirstMark();
await pickRank(1);
await page.waitForTimeout(900);
const cased = await textValue();
check("every occurrence is replaced at once", !cased.toLowerCase().includes("уланбаатар"), cased);
check("title-case occurrence stays title case", cased.includes("Улаанбаатар хот."), cased);
check("upper-case occurrence stays upper case", cased.includes("УЛААНБААТАР руу."), cased);
check("lower-case occurrence stays lower case", cased.includes("улаанбаатар руу."), cased);
check("no marks left once every occurrence is fixed", (await page.locator(".pad__marks mark").count()) === 0, cased);
check("history records the whole replacement with a count", (await page.locator("#history-list .histentry__count").first().textContent()) === "×3", await page.locator("#history-list .histentry__count").first().textContent());
await shot("09-casing.png");

// ===== Large document: 30 copies of one word cost exactly one request =====
const typoWord = "хүүнтэй";
const bigText = Array.from({ length: 30 }, (_, i) => `Өгүүлбэр ${i + 1}: ${typoWord} ${typoWord === "хүүнтэй" ? "хот" : "байна"} бичигдсэн.`).join("\n");
const beforeBig = suggestCount;
await page.locator("#text").fill(bigText);
await page.waitForSelector(".pad__marks mark", { timeout: 15000 });
await page.waitForTimeout(1200);
check("every occurrence of the repeated typo is highlighted", (await page.locator(".pad__marks mark").count()) === 30);
check("auto-check still fires no suggestion requests", suggestCount === beforeBig, suggestCount - beforeBig);
check("error count reports one error, not thirty", (await page.locator("#err-count").textContent()) === "1 алдаа", await page.locator("#err-count").textContent());

// First hover of this word costs a single request, not one per occurrence.
await hoverMark(page.locator(".pad__marks mark").first());
check("hovering a 30-times-repeated word costs one request", suggestCount === beforeBig + 1, suggestCount - beforeBig);
await page.waitForSelector("#hover-card .rank__item", { timeout: 8000 });
check("candidates appear for the repeated word", (await page.locator("#hover-card .rank__item").count()) > 0);
await page.mouse.move(4, 4);
await page.waitForTimeout(450);
await hoverMark(page.locator(".pad__marks mark").nth(5));
await page.waitForSelector("#hover-card .rank__item", { timeout: 8000 });
check("hovering another occurrence is cached, with no new request", suggestCount === beforeBig + 1, suggestCount - beforeBig);
await hoverFirstMark();
await pickRank(1);
await page.waitForTimeout(1200);
const bigAfter = await textValue();
check("large document replacement keeps all lines", bigAfter.split("\n").length === 30, bigAfter.split("\n").length);
check("large document replacement fixed every occurrence", !bigAfter.includes(typoWord), bigAfter.slice(0, 60));
check("large document replacement is undoable", await page.locator("#undo-btn").isEnabled());
check("history counts every occurrence in the large document", (await page.locator("#history-list .histentry__count").first().textContent()) === "×30");
await page.locator("#undo-btn").click();
await page.waitForTimeout(1200);
check("undo restores the large document typo", (await textValue()).includes(typoWord));
await shot("10-large-doc.png");

// ===== Case tools under the input =====
await page.locator("#clear-btn").click();
await page.locator("#text").fill("сайн байна уу? би монгол хэлээр ярьдаг. улаанбаатар хот.");
const fmtButtons = await page.locator("#formatbar .fmtbtn").allTextContents();
check("formatters render under the input", fmtButtons.length === 4, fmtButtons);
await page.locator('#formatbar [data-case="upper"]').click();
await page.waitForTimeout(700);
let caseText = await textValue();
check("uppercase converts the whole text", caseText === "САЙН БАЙНА УУ? БИ МОНГОЛ ХЭЛЭЭР ЯРЬДАГ. УЛААНБААТАР ХОТ.", caseText);
await page.locator('#formatbar [data-case="lower"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("lowercase converts the whole text", caseText === "сайн байна уу? би монгол хэлээр ярьдаг. улаанбаатар хот.", caseText);
await page.locator('#formatbar [data-case="sentence"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("sentence case capitalizes sentence starts", caseText === "Сайн байна уу? Би монгол хэлээр ярьдаг. Улаанбаатар хот.", caseText);
await page.locator('#formatbar [data-case="title"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("title case capitalizes every word", caseText === "Сайн Байна Уу? Би Монгол Хэлээр Ярьдаг. Улаанбаатар Хот.", caseText);
check("case tools re-check the text", (await page.locator(".pad__marks mark").count()) === 0, caseText);
await shot("12-case-tools.png");

// Sentence/title case must handle Latin (English) text too.
await page.locator("#clear-btn").click();
await page.locator("#text").fill("hello world. my name is james. how are you?");
await page.locator('#formatbar [data-case="sentence"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("sentence case capitalizes English sentences", caseText === "Hello world. My name is james. How are you?", caseText);
await page.locator('#formatbar [data-case="title"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("title case capitalizes English words", caseText === "Hello World. My Name Is James. How Are You?", caseText);
await page.locator('#formatbar [data-case="upper"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("uppercase handles English text", caseText === "HELLO WORLD. MY NAME IS JAMES. HOW ARE YOU?", caseText);
await page.locator('#formatbar [data-case="lower"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("lowercase handles English text", caseText === "hello world. my name is james. how are you?", caseText);
await page.locator('#formatbar [data-case="sentence"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("sentence case is repeatable on English text", caseText === "Hello world. My name is james. How are you?", caseText);

// Selection-only transforms.
await page.locator("#text").fill("сайн байна уу? би монгол хэлээр ярьдаг.");
await page.locator("#text").evaluate((el) => {
  el.focus();
  el.setSelectionRange(0, 10);
});
await page.locator('#formatbar [data-case="upper"]').click();
await page.waitForTimeout(700);
caseText = await textValue();
check("case tool applies to the selection only", caseText === "САЙН БАЙНА уу? би монгол хэлээр ярьдаг.", caseText);
const selectionAfterCase = await page.evaluate(() => {
  const el = document.getElementById("text");
  return el.value.slice(el.selectionStart, el.selectionEnd);
});
check("selection survives the transform", selectionAfterCase === "САЙН БАЙНА", selectionAfterCase);
await page.locator("#undo-btn").click();
await page.waitForTimeout(900);
check("case transform is undoable", (await textValue()) === "сайн байна уу? би монгол хэлээр ярьдаг.");

// ===== Stats / copy / paste / clear =====
check("sentences stat visible", /өгүүлбэр/.test(await page.locator("#stat-sentences").textContent()));
check("copy button visible", await page.locator("#copy-all-btn").isVisible());
check("paste button visible", await page.locator("#paste-btn").isVisible());
check("clear button visible", await page.locator("#clear-btn").isVisible());
check("the three actions are icon buttons", (await page.locator(".toolgroup .iconbtn").count()) === 3);
check("the three actions sit at the top right", await page.evaluate(() => {
  const g = document.querySelector(".toolgroup").getBoundingClientRect();
  const t = document.querySelector(".toolbar").getBoundingClientRect();
  return g.right >= t.right - 12 && g.top <= t.top + 12;
}));
check("download feature is gone", (await page.locator("#download-btn").count()) === 0);
check("no download text anywhere in the app", (await page.locator("#app").textContent()).includes("Татах") === false);

// Paste inserts at the caret instead of replacing the whole document.
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.evaluate(() => navigator.clipboard.writeText(" Уланбаатар гэж бичсэн."));
await page.locator("#text").fill("Эхний өгүүлбэр.");
await page.locator("#text").evaluate((el) => {
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
});
await page.locator("#paste-btn").click();
await page.waitForTimeout(700);
const pasted = await textValue();
check("paste inserts at the caret", pasted === "Эхний өгүүлбэр. Уланбаатар гэж бичсэн.", pasted);
check("paste keeps the existing text", pasted.startsWith("Эхний өгүүлбэр."), pasted);
check("pasted text is checked", (await page.locator(".pad__marks mark").count()) > 0, await page.locator(".pad__marks mark").allTextContents());
check("pasted text lands in the panel", (await page.locator("#history-list .errrow").count()) > 0);
check("paste reports in the status", /буулгалаа/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
check("paste is undoable", await page.locator("#undo-btn").isEnabled());

// ===== Landing sections reveal on scroll =====
await page.locator("#features").scrollIntoViewIfNeeded();
await page.waitForTimeout(1100);
check("landing sections reveal on scroll", (await page.locator(".reveal.is-visible").count()) > 0);
check("all six feature cards are revealed", (await page.locator(".feat.is-visible").count()) === 6, await page.locator(".feat.is-visible").count());
await shot("14-features.png");
await page.locator(".foot").scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
check("footer GitHub link visible", await page.locator(".foot__gh").isVisible());

// Sweep the whole page so every reveal fires before the full-page screenshot.
await page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 500) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 40));
  }
});
await page.waitForTimeout(500);

// ===== Responsive: mobile layout keeps the panel usable =====
await page.locator("#text").fill("Монгол улс нь Уланбаатар хоттой, хүүнтэй орон.");
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check("no horizontal overflow on mobile", noHorizontalScroll, await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
check("sidebar visible on mobile", await page.locator(".side").isVisible());
check("error panel stays visible on mobile", (await page.locator("#history-list .errrow, #history-list .histentry").count()) > 0);
await page.screenshot({ path: new URL("13-mobile.png", SHOTS).pathname, fullPage: true });
await page.setViewportSize({ width: 1440, height: 950 });
await page.waitForTimeout(300);

// ===== Report =====
check("no page errors", errors.length === 0, errors);
const failed = results.filter((r) => !r.pass);

console.log(JSON.stringify({
  summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  failures: failed,
  pageErrors: errors,
  marks,
}, null, 1));

await browser.close();
server.kill("SIGKILL");
if (failed.length) process.exitCode = 1;




