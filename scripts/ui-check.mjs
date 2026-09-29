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

async function hoverFirstMark() {
  await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
  await hoverMark(page.locator(".pad__marks mark").first());
  await page.waitForSelector("#hover-card .rank__item", { timeout: 8000 });
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
check("empty title names the history", (await page.locator("#empty-title").textContent()) === "Солилтын түүх хоосон");
check("history list empty at start", (await page.locator("#history-list .histentry").count()) === 0);
check("no card elements exist anymore", (await page.locator(".card, #cards, #all-list, .tabs").count()) === 0);
check("no marks at start", (await page.locator(".pad__marks mark").count()) === 0);
check("undo disabled at start", await page.locator("#undo-btn").isDisabled());
check("redo disabled at start", await page.locator("#redo-btn").isDisabled());
check("samples menu closed at start", await page.locator("#samples-menu").isHidden());
check("fix all disabled at start", await page.locator("#fix-all-btn").isDisabled());
check("format bar shows four tools", (await page.locator("#formatbar .fmtbtn").count()) === 4);
const padBox0 = await page.locator("#pad").boundingBox();
const fmtBox0 = await page.locator("#formatbar").boundingBox();
check("formatters sit under the input", fmtBox0.y >= padBox0.y + padBox0.height - 2, { padBottom: padBox0.y + padBox0.height, fmt: fmtBox0.y });
await shot("01-empty.png");

// ===== Samples menu =====
await page.locator("#samples-btn").click();
const menuItems = await page.locator("#samples-menu .menu__item").allTextContents();
check("samples menu lists samples", menuItems.length >= 2, menuItems);
check("aria-expanded true while open", (await page.locator("#samples-btn").getAttribute("aria-expanded")) === "true");
await page.keyboard.press("Escape");
check("escape closes the samples menu", await page.locator("#samples-menu").isHidden());

// ===== Load sample: every flagged word is highlighted at once =====
await page.locator("#sample-btn").click();
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
const marks = await page.locator(".pad__marks mark").allTextContents();
const uniqueMarks = [...new Set(marks.map((m) => m.toLowerCase()))];
check("sample produces marks", marks.length > 0, marks);
check("marks cover every flagged occurrence", marks.length >= uniqueMarks.length, { marks: marks.length, uniqueMarks });
const tintedCount = await page.evaluate(() =>
  [...document.querySelectorAll(".pad__marks mark")].filter((m) => getComputedStyle(m).backgroundColor !== "rgba(0, 0, 0, 0)").length
);
check("all misspellings are tinted at once", tintedCount === marks.length, { tintedCount, marks: marks.length });
check("hover card hidden until hovered", await page.locator("#hover-card").isHidden());
check("fix all enabled with errors present", !(await page.locator("#fix-all-btn").isDisabled()));
await shot("02-flagged.png");

// ===== Hover before checking: card only, no fetch, prompt instead of candidates =====
const typo = "Уланбаатар";
await hoverMark(page.locator(".pad__marks mark").first());
check("hover opens the card without checking", await page.locator("#hover-card").isVisible());
check("hover without checking offers no candidates", (await page.locator("#hover-card .rank__item").count()) === 0);
check("hover prompts to run the checker", /Алдаа шалгах/.test(await page.locator("#hover-card .rank__hint").textContent()));
check("no suggestion request fires on hover alone", suggestCount === 0, suggestCount);
await page.mouse.move(4, 4);
await page.waitForTimeout(450);
check("prompt card closes when the pointer leaves", await page.locator("#hover-card").isHidden());

// ===== Алдаа шалгах fetches the candidates; hover then opens them instantly =====
await page.locator("#check-btn").click();
await hoverFirstMark();
check("check button fetches suggestions", suggestCount > 0, suggestCount);
check("suggestions are fetched one at a time", maxInflight <= 1, maxInflight);
check("hover opens the suggestion card", await page.locator("#hover-card").isVisible());
check("hover highlights every occurrence of the word", (await page.locator(".pad__marks mark.is-hover").count()) >= 1);
const rankItems = await page.locator("#hover-card .rank__item").allTextContents();
check("hover lists ranked candidates", rankItems.length > 0, rankItems);
const topCandidate = await page.locator("#hover-card .rank__word").first().textContent();
const topRankNo = await page.locator("#hover-card .rank__no").first().textContent();
check("top candidate is ranked first", topRankNo === "1" && topCandidate === "Улаанбаатар", { topRankNo, topCandidate });
check("hover card shows nothing but the candidate list and actions", (await page.locator("#hover-card .card__explain, #hover-card .rank__hint").count()) === 0);
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

// ===== Text file import =====
const txtPath = new URL("typo-sample.txt", TMP).pathname;
await writeFile(txtPath, "Энэ бол шинэ файл юм. Уланбаатар хотод морь унаа байна.\nДараагийн мөр: сайхан өдөр байна.\n");
await page.setInputFiles("#file-input", txtPath);
await page.waitForFunction(() => document.getElementById("text").value.startsWith("Энэ бол шинэ"), null, { timeout: 8000 });
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
const txtValue = await textValue();
check("txt file loaded into the editor", txtValue.startsWith("Энэ бол шинэ файл юм."), txtValue.slice(0, 40));
check("txt newline preserved", txtValue.includes("байна.\nДараагийн мөр"));
check("loaded file is checked", (await page.locator(".pad__marks mark").count()) > 0);
check("status names the loaded file", /typo-sample\.txt/.test(await page.locator("#status").textContent()), await page.locator("#status").textContent());
check("undo available after import", !(await page.locator("#undo-btn").isDisabled()));
await shot("05-txt-import.png");

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
await shot("06-docx-import.png");

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
await page.locator("#sample-btn").click();
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
await page.locator("#clear-btn").click();
await page.waitForTimeout(300);
check("clear empties the editor", (await textValue()) === "");
check("clear removes all marks", (await page.locator(".pad__marks mark").count()) === 0);
check("clear disables fix all", await page.locator("#fix-all-btn").isDisabled());
check("clear resets stats", (await page.locator("#stat-words").textContent()) === "0 үг");
check("empty state reflects empty history", await page.locator("#empty").isVisible());
await shot("08-cleared.png");

// ===== Replacement history clears on demand =====
await page.locator("#text").fill("Энд улаанбатар гэсэн алдаа байна.");
await page.locator("#check-btn").click();
await hoverFirstMark();
await pickRank(1);
await page.waitForTimeout(900);
check("replacement adds a history entry", (await page.locator("#history-list .histentry").count()) === 1);
await page.locator("#clear-history").click();
await page.waitForTimeout(200);
check("history clear button empties the list", (await page.locator("#history-list .histentry").count()) === 0);
check("history clear restores the empty state", await page.locator("#empty").isVisible());
check("history clear reports in the status", /цэвэрлэлээ/.test(await page.locator("#status").textContent()));

// ===== Typing triggers automatic checking =====
await page.locator("#text").fill("Энэ өгүүлбэрт улаанбатар гэсэн алдаа байна.");
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
check("typing auto-checks the text", (await page.locator(".pad__marks mark").count()) > 0);
const typedWord = await page.locator(".pad__marks mark").first().textContent();
await page.locator("#check-btn").click();
await hoverFirstMark();
const typedBest = await page.locator("#hover-card .rank__word").first().textContent();
check("checking offers ranked candidates", typedBest.length > 0 && typedBest.toLowerCase() !== typedWord.toLowerCase(), { typedWord, typedBest });
await pickRank(1);
await page.waitForTimeout(900);
const typedFixed = await textValue();
check("lowercase typo is replaced with the chosen candidate", typedFixed.includes(typedBest.toLowerCase()) && !typedFixed.includes(typedWord), typedFixed);
check("replacement status names both words", (await page.locator("#status").textContent()).includes(typedWord) && (await page.locator("#status").textContent()).includes(typedBest), await page.locator("#status").textContent());

// ===== Replace-all with per-occurrence casing =====
await page.locator("#text").fill("Уланбаатар хот. УЛАНБААТАР руу. уланбаатар руу.");
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
check("repeated typo yields three marks", (await page.locator(".pad__marks mark").count()) === 3);
await page.locator("#check-btn").click();
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

// ===== Large document: checking alone and hover alone never touch /suggest =====
const typoWord = "Уланбаатар";
const bigText = Array.from({ length: 30 }, (_, i) => `Өгүүлбэр ${i + 1}: ${typoWord} хотод морь унаа байна.`).join("\n");
const beforeBig = suggestCount;
await page.locator("#text").fill(bigText);
await page.waitForSelector(".pad__marks mark", { timeout: 15000 });
await page.waitForTimeout(1200);
check("every occurrence of the repeated typo is highlighted", (await page.locator(".pad__marks mark").count()) === 30);
check("auto-check fires no suggestion requests", suggestCount === beforeBig, suggestCount - beforeBig);
await hoverMark(page.locator(".pad__marks mark").first());
check("hover fires no suggestion request", suggestCount === beforeBig, suggestCount - beforeBig);
check("cached candidates appear on hover without a fetch", (await page.locator("#hover-card .rank__item").count()) > 0);
await page.mouse.move(4, 4);
await page.waitForTimeout(450);
await page.locator("#check-btn").click();
await hoverFirstMark();
check("candidates open from the cache after checking, with no new requests", suggestCount === beforeBig, suggestCount - beforeBig);
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

// ===== Fix all =====
await page.locator("#clear-btn").click();
await page.locator("#text").fill("Энд монгл болон саайн үгс байна.");
await page.waitForSelector(".pad__marks mark", { timeout: 8000 });
check("fix all enabled when errors exist", !(await page.locator("#fix-all-btn").isDisabled()));
const beforeFixAll = await page.locator("#history-list .histentry").count();
await page.locator("#fix-all-btn").click();
await page.waitForTimeout(1500);
const fixedAllText = await textValue();
check("fix all replaces all errors with top candidates", fixedAllText.includes("монгол") && fixedAllText.includes("сайн"), fixedAllText);
check("fix all clears every mark", (await page.locator(".pad__marks mark").count()) === 0);
check("fix all records both replacements in history", (await page.locator("#history-list .histentry").count()) === beforeFixAll + 2);
check("fix all disabled again once clean", await page.locator("#fix-all-btn").isDisabled());
await shot("11-fix-all.png");

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

// ===== Stats / copy / download =====
check("sentences stat visible", /өгүүлбэр/.test(await page.locator("#stat-sentences").textContent()));
check("reading time stat visible", /мин/.test(await page.locator("#stat-reading").textContent()));
check("copy all button visible", await page.locator("#copy-all-btn").isVisible());
check("download button visible", await page.locator("#download-btn").isVisible());

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
check("history stays visible on mobile", (await page.locator("#history-list .histentry").count()) > 0);
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




