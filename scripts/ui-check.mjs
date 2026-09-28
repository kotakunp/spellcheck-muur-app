import { spawn } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const PORT = Number(process.env.UI_PORT || 4100 + Math.floor(Math.random() * 200));
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = new URL("./shots/", import.meta.url);
const TMP = new URL("./tmp/", import.meta.url);

await mkdir(SHOTS, { recursive: true });
await mkdir(TMP, { recursive: true });

// ---- minimal .docx builder (stored + deflate entries) so the ZIP reader is exercised ----
function zipEntry(name, content, method) {
  const raw = Buffer.from(content, "utf8");
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const nameBuf = Buffer.from(name, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  return { nameBuf, local, data, raw, method };
}

function buildDocx(paragraphs) {
  const xml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("") +
    "</w:body></w:document>";
  const entries = [
    zipEntry("[Content_Types].xml", "<Types/>", 0),
    zipEntry("word/document.xml", xml, 8),
  ];
  const parts = [];
  let offset = 0;
  for (const entry of entries) {
    entry.offset = offset;
    parts.push(entry.local, entry.nameBuf, entry.data);
    offset += entry.local.length + entry.nameBuf.length + entry.data.length;
  }
  const central = [];
  let centralSize = 0;
  for (const entry of entries) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(entry.method, 10);
    head.writeUInt32LE(0, 16);
    head.writeUInt32LE(entry.data.length, 20);
    head.writeUInt32LE(entry.raw.length, 24);
    head.writeUInt16LE(entry.nameBuf.length, 28);
    head.writeUInt32LE(entry.offset, 42);
    central.push(head, entry.nameBuf);
    centralSize += head.length + entry.nameBuf.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(parts), cd, eocd]);
}

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

const shot = (name) => page.screenshot({ path: new URL(name, SHOTS).pathname });
const textValue = () => page.locator("#text").inputValue();

await page.goto(BASE, { waitUntil: "networkidle" });

// ===== Empty state =====
check("empty state visible", await page.locator("#empty").isVisible());
check("empty title prompts for text", (await page.locator("#empty-title").textContent()) === "Текст бичнэ үү");
check("sidebar cards empty at start", (await page.locator("#cards .card").count()) === 0);
check("counts zero at start", (await page.locator("#sugs-count").textContent()) === "0" && (await page.locator("#all-count").textContent()) === "0");
check("undo disabled at start", await page.locator("#undo-btn").isDisabled());
check("redo disabled at start", await page.locator("#redo-btn").isDisabled());
check("samples menu closed at start", await page.locator("#samples-menu").isHidden());
await shot("01-empty.png");

// ===== Samples menu =====
await page.locator("#samples-btn").click();
const menuItems = await page.locator("#samples-menu .menu__item").allTextContents();
check("samples menu lists samples", menuItems.length >= 2, menuItems);
check("aria-expanded true while open", (await page.locator("#samples-btn").getAttribute("aria-expanded")) === "true");
await page.keyboard.press("Escape");
// ===== Load sample, cards render =====
await page.locator("#sample-btn").click();
await page.waitForSelector(".pad__marks mark", { timeout: 6000 });
await page.waitForSelector("#cards .card .chip, #cards .card .card__hint", { timeout: 8000 });

const marks = await page.locator(".pad__marks mark").allTextContents();
const uniqueMarks = [...new Set(marks)];
const cards = await page.locator("#cards .card").count();
check("sample produces marks", marks.length > 0, marks);
check("every mark gets a card", cards === uniqueMarks.length, { cards, uniqueMarks });
check("sugs count matches cards", (await page.locator("#sugs-count").textContent()) === String(cards));
check("all count matches cards", (await page.locator("#all-count").textContent()) === String(cards));
check("empty state hidden with results", await page.locator("#empty").isHidden());
check("stats show words and chars", /үг/.test(await page.locator("#stat-words").textContent()) && /тэмдэгт/.test(await page.locator("#stat-chars").textContent()));
check("first card is active", (await page.locator("#cards .card.is-active").count()) === 1);
check("active card is index 0", (await page.locator("#cards .card.is-active").getAttribute("data-index")) === "0");
await shot("02-flagged.png");

// ===== Suggestion chips for the "Уланбаатар" card =====
const typo = "Уланбаатар";
const typoCard = page.locator("#cards .card", { has: page.locator(`.pill:text-is("${typo}")`) }).first();
check("typo card exists", (await typoCard.count()) === 1);
await typoCard.locator(".chip").first().waitFor({ timeout: 8000 });
const chips = await typoCard.locator(".chip").allTextContents();
check("typo card has suggestion chips", chips.length > 0, chips);
check("top chip is chip--best", (await typoCard.locator(".chip--best").count()) === 1);
check("chips include Улаанбаатар", chips.some((c) => c.includes("Улаанбаатар")), chips);
check("best chip carries enter hint", (await typoCard.locator(".chip--best .chip__enter").count()) === 1);
check("explain block visible on card", await typoCard.locator(".card__explain").isVisible());
check("explain labels the suggestion", /тайлбар/.test(await typoCard.locator(".card__explain-label").textContent()));
check("explain mentions the misspelled word", (await typoCard.locator(".card__explain-text").textContent()).includes(typo));
check("ignore button offered", await typoCard.locator('[data-role="ignore"]').isVisible());

// ===== Replace by clicking the best chip =====
const before = await textValue();
await typoCard.locator(".chip--best").click();
await page.waitForTimeout(900);
const after = await textValue();
check("typo present before replace", before.includes(typo));
check("typo gone after replace", !after.includes(typo));
check("correct form present after replace", after.includes("Улаанбаатар"), after.slice(0, 60));
check("replaced card removed from sidebar", (await page.locator("#cards .card .pill", { hasText: typo }).count()) === 0);
const marksAfter = await page.locator(".pad__marks mark").allTextContents();
check("mark count drops after replace", marksAfter.length < marks.length, { before: marks.length, after: marksAfter.length });
await shot("03-replaced.png");

// ===== Undo / redo =====
await page.locator("#undo-btn").click();
await page.waitForTimeout(900);
const undone = await textValue();
check("undo restores the typo", undone.includes(typo));
check("redo becomes enabled after undo", !(await page.locator("#redo-btn").isDisabled()));
await page.locator("#redo-btn").click();
await page.waitForTimeout(900);
const redone = await textValue();
check("redo re-applies the fix", !redone.includes(typo) && redone.includes("Улаанбаатар"));
check("undo still enabled after redo", !(await page.locator("#undo-btn").isDisabled()));
await shot("04-undo-redo.png");
// ===== Tabs =====
await page.locator("#tab-all").click();
const rows = await page.locator("#all-list .allrow").count();
const cardsNow = await page.locator("#cards .card").count();
check("all tab lists every card word", rows === cardsNow, { rows, cardsNow });
check("cards hidden on all tab", await page.locator("#cards").isHidden());
check("all list visible on all tab", await page.locator("#all-list").isVisible());
check("all tab aria-selected", (await page.locator("#tab-all").getAttribute("aria-selected")) === "true");
check("row shows occurrence count", /удаа \/ \d+ алдаанаас/.test(await page.locator("#all-list .allrow__count").first().textContent()));
check("active row highlighted", (await page.locator("#all-list .allrow.is-active").count()) === 1);
await shot("05-all-tab.png");

const thirdRow = page.locator("#all-list .allrow").nth(Math.min(2, rows - 1));
const thirdWord = await thirdRow.locator(".allrow__word").textContent();
await thirdRow.click();
check("row click moves the active card", (await page.locator("#all-list .allrow.is-active .allrow__word").textContent()) === thirdWord);
const activeMarkText = await page.locator(".pad__marks mark.is-active").first().textContent();
check("active mark matches active row", activeMarkText === thirdWord, { activeMarkText, thirdWord });
check("selection follows active word", (await page.evaluate(() => {
  const el = document.getElementById("text");
  return el.value.slice(el.selectionStart, el.selectionEnd);
})) === thirdWord);

// "goto" arrow jumps back to the suggestions tab with that card active.
await thirdRow.locator('[data-role="goto"]').click();
await page.waitForTimeout(200);
check("goto switches to sugs tab", (await page.locator("#tab-sugs").getAttribute("aria-selected")) === "true");
check("goto activates the same card", (await page.locator("#cards .card.is-active .pill").textContent()) === thirdWord, thirdWord);
check("cards visible again", await page.locator("#cards").isVisible());

// ===== Prev / next navigation (start from the first error) =====
await page.locator("#tab-all").click();
await page.locator("#all-list .allrow").first().locator('[data-role="goto"]').click();
await page.waitForTimeout(200);
check("goto returns to the sugs tab", (await page.locator("#tab-sugs").getAttribute("aria-selected")) === "true");
const startIndex = Number(await page.locator("#cards .card.is-active").getAttribute("data-index"));
check("goto from first row activates index 0", startIndex === 0, startIndex);
await page.locator("#cards .card.is-active [data-nav='1']").click();
const nextIndex = Number(await page.locator("#cards .card.is-active").getAttribute("data-index"));
check("next moves forward one card", nextIndex === startIndex + 1, { startIndex, nextIndex });
await page.locator("#cards .card.is-active [data-nav='-1']").click();
const backIndex = Number(await page.locator("#cards .card.is-active").getAttribute("data-index"));
check("prev moves back one card", backIndex === startIndex, { startIndex, backIndex });
check("nav count label tracks position", (await page.locator("#cards .card.is-active .card__count").textContent()) === `${backIndex + 1} / ${cardsNow}`, { backIndex, cardsNow });

// ===== Clicking a flagged word in the text activates its card =====
const firstMarkWord = await page.locator("#cards .card").nth(1).locator(".pill").textContent();
const markForWord = page.locator(".pad__marks mark", { hasText: firstMarkWord }).first();
const markBox = await markForWord.boundingBox();
await page.mouse.click(markBox.x + markBox.width / 2, markBox.y + markBox.height / 2);
await page.waitForTimeout(200);
check("clicking a mark activates its card", (await page.locator("#cards .card.is-active .pill").textContent()) === firstMarkWord, firstMarkWord);
check("clicking a mark selects the word", (await page.evaluate(() => {
  const el = document.getElementById("text");
  return el.value.slice(el.selectionStart, el.selectionEnd);
})) === firstMarkWord);
check("mark gets is-active class", (await page.locator(".pad__marks mark.is-active").count()) > 0);
await shot("06-mark-click.png");
// ===== Add to dictionary =====
const dictCard = page.locator("#cards .card").first();
const dictWord = await dictCard.locator(".pill").textContent();
const countBeforeDict = await page.locator("#cards .card").count();
await dictCard.locator('[data-role="ignore"]').click();
await page.waitForTimeout(300);
check("ignored card leaves the sidebar", (await page.locator("#cards .card").count()) === countBeforeDict - 1, dictWord);
check("ignored word loses its mark", (await page.locator(".pad__marks mark", { hasText: dictWord }).count()) === 0, dictWord);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sc-ignored-v1") || "[]"));
check("dictionary persisted to localStorage", stored.includes(dictWord.toLowerCase()), stored);
check("status confirms dictionary add", /тольд нэмлээ/i.test(await page.locator("#status").textContent()));
await shot("07-ignored.png");

// Clearing the dictionary brings the word back.
await page.locator("#settings-btn").click();
check("settings menu opens", await page.locator("#settings-menu").isVisible());
await page.locator("#clear-dict").click();
await page.waitForSelector(`#cards .card .pill:text-is("${dictWord}")`, { timeout: 8000 });
check("cleared dictionary restores the card", (await page.locator("#cards .card").count()) === countBeforeDict);
check("settings menu closed after clear", await page.locator("#settings-menu").isHidden());
check("dictionary emptied in storage", (await page.evaluate(() => JSON.parse(localStorage.getItem("sc-ignored-v1") || "[]"))).length === 0);

// ===== Text file import =====
const txtPath = new URL("typo-sample.txt", TMP).pathname;
await writeFile(txtPath, "Энэ бол шинэ файл юм. Уланбаатар хотод морь унаа байна.\nДараагийн мөр: сайхан өдөр байна.\n");
await page.setInputFiles("#file-input", txtPath);
await page.waitForFunction(() => document.getElementById("text").value.startsWith("Энэ бол шинэ"), null, { timeout: 8000 });
await page.waitForSelector("#cards .card .chip", { timeout: 8000 });
const txtValue = await textValue();
check("txt file loaded into the editor", txtValue.startsWith("Энэ бол шинэ файл юм."), txtValue.slice(0, 40));
check("txt newline preserved", txtValue.includes("байна.\nДараагийн мөр"));
check("loaded file is checked", (await page.locator(".pad__marks mark").count()) > 0);
check("status names the loaded file", /typo-sample\.txt/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
check("undo available after import", !(await page.locator("#undo-btn").isDisabled()));
await shot("08-txt-import.png");

// ===== DOCX import (exercises the deflate ZIP reader) =====
const docxPath = new URL("typo-sample.docx", TMP).pathname;
await writeFile(docxPath, buildDocx(["Монгол хэлний алдаатай өгүүлбэр.", "Уланбаатар хотын нэр буруу бичигдсэн."]));
await page.setInputFiles("#file-input", docxPath);
await page.waitForFunction(() => document.getElementById("text").value.includes("Монгол хэлний"), null, { timeout: 8000 });
const docxValue = await textValue();
check("docx paragraphs extracted", docxValue.includes("Уланбаатар хотын нэр буруу бичигдсэн."), docxValue);
check("docx newline preserved between paragraphs", docxValue.includes("өгүүлбэр.\nУланбаатар"));
check("docx content checked for errors", (await page.locator(".pad__marks mark").count()) > 0);
check("docx status names the file", /typo-sample\.docx/.test(await page.locator("#status").textContent()));
await shot("09-docx-import.png");

// ===== Drag & drop a file onto the dropzone =====
await page.evaluate(async () => {
  const data = new DataTransfer();
  data.items.add(new File(["Чирж оруулсан текст. Дараа нь улаанбатар гэж бичсэн."], "dropped.txt", { type: "text/plain" }));
  const zone = document.getElementById("dropzone");
  zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
  zone.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
});
await page.waitForFunction(() => document.getElementById("text").value.startsWith("Чирж оруулсан"), null, { timeout: 8000 });
check("dropped file loaded", (await textValue()).includes("Чирж оруулсан текст."));
check("dropzone highlight cleared after drop", (await page.locator("#dropzone.is-over").count()) === 0);
await shot("10-dropped.png");

// Unsupported file type reports a friendly error.
await page.evaluate(() => {
  const input = document.getElementById("file-input");
  const data = new DataTransfer();
  data.items.add(new File(["\u0000\u0001binary"], "bad.docx"));
  input.files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.waitForTimeout(400);
check("broken docx reports an error", /уншиж чадсангүй/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
check("error status styled", (await page.locator("#status.status--info").count()) === 0);
// ===== Keyboard shortcut: Cmd/Ctrl+Enter re-checks =====
await page.locator("#text").click();
await page.keyboard.press("ControlOrMeta+Enter");
await page.waitForTimeout(900);
check("shortcut keeps results in sync", (await page.locator("#cards .card").count()) > 0);

// ===== Stylesheet sanity: every rule must be top level (only @media may nest) =====
const cssHealth = await page.evaluate(() => {
  const sheet = [...document.styleSheets].find((s) => s.href?.includes("styles.css"));
  const nested = [...sheet.cssRules].filter((r) => !r.conditionText && r.cssRules && r.cssRules.length > 0).map((r) => r.selectorText);
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
await shot("11-dark.png");
await page.keyboard.press("Escape");
check("escape closes settings menu", await page.locator("#settings-menu").isHidden());
await page.reload({ waitUntil: "networkidle" });
check("dark theme survives reload", (await page.locator("html").getAttribute("data-theme")) === "dark");
check("theme checkbox reflects stored theme", await page.locator("#theme-toggle").isChecked());
await page.locator("#settings-btn").click();
await page.locator("#theme-toggle").uncheck();
check("light theme override stored", (await page.evaluate(() => localStorage.getItem("sc-theme-v1"))) === "light");
check("light theme attribute applied", (await page.locator("html").getAttribute("data-theme")) === "light");
await page.keyboard.press("Escape");

// ===== Clear button =====
await page.locator("#sample-btn").click();
await page.waitForSelector("#cards .card", { timeout: 8000 });
await page.locator("#clear-btn").click();
await page.waitForTimeout(300);
check("clear empties the editor", (await textValue()) === "");
check("clear empties the sidebar", (await page.locator("#cards .card").count()) === 0);
check("clear empties the all list", (await page.locator("#all-list .allrow").count()) === 0);
check("clear resets counters", (await page.locator("#sugs-count").textContent()) === "0");
check("clear resets stats", (await page.locator("#stat-words").textContent()) === "0 үг");
check("empty state returns after clear", await page.locator("#empty").isVisible());
check("empty title reflects cleared editor", (await page.locator("#empty-title").textContent()) === "Текст бичнэ үү");
await shot("12-cleared.png");

// ===== Typing triggers automatic checking =====
await page.locator("#text").fill("Энэ өгүүлбэрт улаанбатар гэсэн алдаа байна.");
await page.waitForSelector("#cards .card", { timeout: 8000 });
check("typing auto-checks the text", (await page.locator(".pad__marks mark").count()) > 0);
const typedCard = page.locator("#cards .card").first();
const typedWord = await typedCard.locator(".pill").textContent();
await typedCard.locator(".chip").first().waitFor({ timeout: 8000 });
const typedChip = (await typedCard.locator(".chip").first().textContent()).replace(/\s*↵\s*$/, "").trim();
check("auto-check offers suggestions", typedChip.length > 0 && typedChip !== typedWord, { typedWord, typedChip });
await typedCard.locator(".chip").first().click();
await page.waitForTimeout(900);
const fixed = await textValue();
check("lowercase typo is replaced with the chosen suggestion", fixed.includes(typedChip) && !fixed.includes(typedWord), fixed);
check("lowercase source keeps lowercase suggestion", typedChip !== typedChip.toUpperCase() && fixed.includes(typedChip.toLowerCase()), fixed);
await shot("13-typed.png");

// ===== Replace-all with per-occurrence casing =====
await page.locator("#text").fill("Уланбаатар хот. УЛАНБААТАР руу. уланбаатар руу.");
await page.waitForSelector("#cards .card .chip", { timeout: 8000 });
const caseCard = page.locator("#cards .card").first();
const caseWord = await caseCard.locator(".pill").textContent();
check("repeated typo produces a single card", (await page.locator("#cards .card").count()) === 1, caseWord);
await page.locator("#tab-all").click();
check("all-errors row counts all three occurrences", /3 удаа/.test(await page.locator("#all-list .allrow__count").first().textContent()), await page.locator("#all-list .allrow__count").first().textContent());
await page.locator("#tab-sugs").click();
await caseCard.locator(".chip--best").click();
await page.waitForTimeout(900);
const cased = await textValue();
check("every occurrence is replaced at once", !cased.toLowerCase().includes("уланбаатар"), cased);
check("title-case occurrence stays title case", cased.includes("Улаанбаатар хот."), cased);
check("upper-case occurrence stays upper case", cased.includes("УЛААНБААТАР руу."), cased);
check("lower-case occurrence stays lower case", cased.includes("улаанбаатар руу."), cased);
check("no marks left once every occurrence is fixed", (await page.locator(".pad__marks mark").count()) === 0, cased);
await shot("13b-casing.png");

// ===== Large document with many errors: sidebar stays usable, requests bounded =====
let inflight = 0;
let maxInflight = 0;
let suggestCount = 0;
page.on("request", (r) => {
  if (!r.url().endsWith("/suggest")) return;
  suggestCount++;
  inflight++;
  maxInflight = Math.max(maxInflight, inflight);
});
page.on("requestfinished", (r) => r.url().endsWith("/suggest") && inflight--);
page.on("requestfailed", (r) => r.url().endsWith("/suggest") && inflight--);

const typoWord = "Уланбаатар";
const bigText = Array.from({ length: 30 }, (_, i) => `Өгүүлбэр ${i + 1}: ${typoWord} хотод морь унаа байна.`).join("\n");
await page.locator("#text").fill(bigText);
await page.waitForSelector("#cards .card .chip", { timeout: 15000 });
await page.waitForTimeout(1500);
check("many occurrences still yield one card", (await page.locator("#cards .card").count()) === 1);
check("occurrence counter reflects the whole document", /30 удаа/.test(await page.locator("#all-list .allrow__count").first().textContent()), await page.locator("#all-list .allrow__count").first().textContent());
check("suggest requests stay bounded", maxInflight <= 6, { suggestCount, maxInflight });
check("sidebar body scrolls instead of growing the page", await page.locator(".side__body").evaluate((el) => el.scrollHeight >= el.clientHeight));
await shot("15-large-doc.png");

// Replacing in a large document rewrites every occurrence.
await page.locator("#cards .card .chip--best").click();
await page.waitForTimeout(1200);
const bigAfter = await textValue();
check("large document replacement keeps all lines", bigAfter.split("\n").length === 30, bigAfter.split("\n").length);
check("large document replacement fixed every occurrence", !bigAfter.includes(typoWord), bigAfter.slice(0, 60));
check("large document replacement is undoable", await page.locator("#undo-btn").isEnabled());
await page.locator("#undo-btn").click();
await page.waitForTimeout(1200);
check("undo restores the large document", (await textValue()).includes(typoWord));

// ===== Responsive: mobile layout keeps the sidebar usable =====
await page.locator("#text").fill("Монгол улс нь Уланбаатар хоттой, хүүнтай орон.");
await page.waitForSelector("#cards .card .chip", { timeout: 8000 });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
const noHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
check("no horizontal overflow on mobile", noHorizontalScroll, await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
check("sidebar visible on mobile", await page.locator(".side").isVisible());
check("cards still rendered on mobile", (await page.locator("#cards .card").count()) > 0);
await page.screenshot({ path: new URL("14-mobile.png", SHOTS).pathname, fullPage: true });

await page.setViewportSize({ width: 1440, height: 950 });
await page.waitForTimeout(300);

// ===== New Feature: Stats display sentences and reading time =====
check("sentences stat visible", /өгүүлбэр/.test(await page.locator("#stat-sentences").textContent()));
check("reading time stat visible", /мин/.test(await page.locator("#stat-reading").textContent()));
check("copy all button visible", await page.locator("#copy-all-btn").isVisible());
check("download button visible", await page.locator("#download-btn").isVisible());

// ===== New Feature: Fix All (Бүгдийг засах) =====
await page.locator("#clear-btn").click();
await page.locator("#text").fill("Энд монгл болон саайн үгс байна.");
await page.waitForSelector('#cards .card .pill:text-is("монгл")', { timeout: 8000 });
await page.waitForSelector("#cards .card .chip", { timeout: 8000 });
check("side bar visible when errors exist", await page.locator("#side-bar").isVisible());
check("fix all button visible", await page.locator("#fix-all-btn").isVisible());
await page.locator("#fix-all-btn").click();
await page.waitForTimeout(1500);
const fixedAllText = await textValue();
check("fix all replaces all errors with top suggestions", fixedAllText.includes("монгол") && fixedAllText.includes("сайн"), fixedAllText);
check("cards cleared after fix all", (await page.locator("#cards .card").count()) === 0);

// ===== New Feature: Skip (Алгасах) =====
await page.locator("#clear-btn").click();
await page.locator("#text").fill("Шинэ нэр болох туршилтт гэж бичлээ.");
await page.waitForSelector('#cards .card .pill:text-is("туршилтт")', { timeout: 8000 });
const skipCard = page.locator("#cards .card").first();
check("skip button available on card", await skipCard.locator('[data-role="skip"]').isVisible());
await skipCard.locator('[data-role="skip"]').click();
await page.waitForTimeout(400);
check("skipped card removed from sidebar", (await page.locator("#cards .card").count()) === 0);
const storedAfterSkip = await page.evaluate(() => JSON.parse(localStorage.getItem("sc-ignored-v1") || "[]"));
check("skipped word NOT written to persistent storage", !storedAfterSkip.includes("туршилтт"), storedAfterSkip);
check("status reports skipped", /алгаслаа/i.test(await page.locator("#status").textContent()));

// ===== Report =====
const failed = results.filter((r) => !r.pass);
check("no page errors", errors.length === 0, errors);

console.log(JSON.stringify({
  summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
  failures: failed,
  pageErrors: errors,
  marks,
  cards,
}, null, 1));

await browser.close();
server.kill("SIGKILL");
if (failed.length) process.exitCode = 1;
