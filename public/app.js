// ===== Refs =====
const padEl = document.getElementById("pad");
const textEl = document.getElementById("text");
const marksEl = document.getElementById("backdrop");
const statusEl = document.getElementById("status");
const statWordsEl = document.getElementById("stat-words");
const statCharsEl = document.getElementById("stat-chars");
const statSentencesEl = document.getElementById("stat-sentences");
const statReadingEl = document.getElementById("stat-reading");
const copyAllBtn = document.getElementById("copy-all-btn");
const downloadBtn = document.getElementById("download-btn");
const sampleBtn = document.getElementById("sample-btn");
const samplesBtn = document.getElementById("samples-btn");
const samplesMenu = document.getElementById("samples-menu");
const clearBtn = document.getElementById("clear-btn");
const checkBtn = document.getElementById("check-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const emptyEl = document.getElementById("empty");
const historyListEl = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");
const fixAllBtn = document.getElementById("fix-all-btn");
const formatBarEl = document.getElementById("formatbar");
const settingsBtn = document.getElementById("settings-btn");
const settingsMenu = document.getElementById("settings-menu");
const themeToggle = document.getElementById("theme-toggle");
const clearDictBtn = document.getElementById("clear-dict");
const hoverCardEl = document.getElementById("hover-card");

const API = "/cms-client/modules/spellchecker";
const CYRILLIC = /[\u0400-\u04FF]+/g;
const STORAGE_KEY = "sc-ignored-v1";
const THEME_KEY = "sc-theme-v1";

const SAMPLES = [
  {
    label: "Богино жишээ",
    text: "Монгол улс нь Азийн зүүн хэсэгт оршино. Уланбаатар хот олон хүүнтэй. Би маргааш нийтийн тээвэрээр худалдааны төв рүү явна.",
  },
  {
    label: "Урт жишээ",
    text:
      "Сайн байна уу? Би өнөөдөр цаг агаар саайн байгаа тул гадуур аяллаа. " +
      "Найзуудтайгаа уулзахдаа монгл хэлээр ярилцаж, хамтдаа гэртээ тээвэрээр ирэв. " +
      "Маргааш ажилдаа яаралтай очих хэрэгтэй тул эрт унтъя.",
  },
];

// ===== State =====
let ignored = new Set(readStored());
let sessionSkipped = new Set();
let misspellings = [];
let replaceLog = [];
let checking = false;
let requestId = 0;
let debounce = null;
let statusIsError = false;
let history = [""];
let hIndex = 0;
let histTimer = null;

class BoundedMap extends Map {
  constructor(maxSize = 300) {
    super();
    this.maxSize = maxSize;
  }
  set(key, value) {
    if (this.has(key)) this.delete(key);
    else if (this.size >= this.maxSize) this.delete(this.keys().next().value);
    return super.set(key, value);
  }
}
const suggestionCache = new BoundedMap(300);

// ===== Small helpers =====
function readStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function storeIgnored() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ignored]));
  } catch {}
}

function escapeHtmlLite(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setStatus(message, kind = "info") {
  statusEl.textContent = message;
  statusIsError = kind === "error" && !!message;
  statusEl.classList.toggle("status--info", !statusIsError && !!message);
}

function formatNum(n) {
  return n.toLocaleString("en-US");
}

function updateStats() {
  const value = textEl.value;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;
  const chars = value.length;
  const sentences = value.trim()
    ? (value.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || []).filter((s) => s.trim().length > 0).length
    : 0;
  const minutes = words > 0 ? Math.max(1, Math.ceil(words / 160)) : 0;
  statWordsEl.textContent = `${formatNum(words)} үг`;
  statCharsEl.textContent = `${formatNum(chars)} тэмдэгт`;
  if (statSentencesEl) statSentencesEl.textContent = `${formatNum(sentences)} өгүүлбэр`;
  if (statReadingEl) statReadingEl.textContent = `~${minutes} мин`;
}

// ===== Layout =====
function fit() {
  textEl.style.height = "0px";
  const limit = Math.max(340, Math.round(window.innerHeight * 0.6));
  textEl.style.height = `${Math.min(textEl.scrollHeight, limit)}px`;
  const scrollbar = textEl.offsetWidth - textEl.clientWidth;
  marksEl.style.paddingRight = "";
  const base = parseFloat(getComputedStyle(marksEl).paddingRight) || 0;
  marksEl.style.paddingRight = `${base + scrollbar}px`;
}

function paintMarks(value, flagged) {
  let html = "";
  let cursor = 0;
  for (const match of value.matchAll(CYRILLIC)) {
    html += escapeHtmlLite(value.slice(cursor, match.index));
    const word = match[0];
    if (flagged.has(word.toLowerCase())) {
      html += `<mark data-word="${escapeHtmlLite(word)}">${escapeHtmlLite(word)}</mark>`;
    } else {
      html += escapeHtmlLite(word);
    }
    cursor = match.index + word.length;
  }
  marksEl.innerHTML = `${html}${escapeHtmlLite(value.slice(cursor))}\n`;
}

function paint() {
  hideHoverCard();
  const value = textEl.value;
  const flagged = new Set(misspellings.map((word) => word.toLowerCase()));
  paintMarks(value, flagged);
  fixAllBtn.disabled = misspellings.length === 0;
}

function markAt(x, y) {
  for (const mark of marksEl.querySelectorAll("mark")) {
    for (const rect of mark.getClientRects()) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return mark;
    }
  }
  return null;
}
// ===== Checking =====
function scheduleCheck() {
  clearTimeout(debounce);
  debounce = setTimeout(runCheck, 400);
}

async function runCheck() {
  clearTimeout(debounce);
  const value = textEl.value;
  updateStats();
  if (!value.trim()) {
    requestId++;
    misspellings = [];
    checking = false;
    setStatus("");
    paint();
    return;
  }
  const id = ++requestId;
  checking = true;
  try {
    const res = await fetch(`${API}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (id !== requestId) return;
    misspellings = data.filter((word) => !ignored.has(word.toLowerCase()) && !sessionSkipped.has(word.toLowerCase()));
    checking = false;
    // A successful check clears a stale connection error, but keeps info messages
    // such as "«file.txt» ачааллаа." that describe what just happened.
    if (statusIsError) setStatus("");
    paint();
  } catch {
    if (id !== requestId) return;
    checking = false;
    setStatus("Шалгаж чадсангүй. Серверт холбогдохгүй байна.", "error");
  }
}

// ===== Replacement history =====
function logReplacement(from, to, count) {
  replaceLog.push({ from, to, count, at: Date.now() });
  if (replaceLog.length > 100) replaceLog.shift();
  renderHistory();
}

function buildHistoryEntry(entry) {
  const row = document.createElement("div");
  row.className = "histentry";
  const time = document.createElement("span");
  time.className = "histentry__time";
  time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const from = document.createElement("span");
  from.className = "histentry__from";
  from.textContent = entry.from;
  const arrow = document.createElement("span");
  arrow.className = "histentry__arrow";
  arrow.textContent = "→";
  const to = document.createElement("span");
  to.className = "histentry__to";
  to.textContent = entry.to;
  row.append(time, from, arrow, to);
  if (entry.count > 1) {
    const count = document.createElement("span");
    count.className = "histentry__count";
    count.textContent = `×${entry.count}`;
    row.append(count);
  }
  return row;
}

function renderHistory() {
  historyListEl.textContent = "";
  emptyEl.hidden = replaceLog.length > 0;
  for (const entry of replaceLog) historyListEl.prepend(buildHistoryEntry(entry));
}
// ===== Suggestions =====
// Suggestions load lazily (on hover/click) and are cached, so a document with
// hundreds of errors never fires hundreds of parallel requests.
async function loadSuggestions(word) {
  if (suggestionCache.has(word)) return suggestionCache.get(word);
  try {
    const res = await fetch(`${API}/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ word }),
    });
    const list = res.ok ? await res.json() : [];
    suggestionCache.set(word, list);
    return list;
  } catch {
    suggestionCache.set(word, []);
    return [];
  }
}

// ===== Replacing =====
function applyCasing(source, target) {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return target.toUpperCase();
  }
  if (source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase();
  }
  return target.toLowerCase();
}

function replaceWord(word, suggestion) {
  const key = word.toLowerCase();
  const value = textEl.value;
  let out = "";
  let cursor = 0;
  let count = 0;
  for (const match of value.matchAll(CYRILLIC)) {
    out += value.slice(cursor, match.index);
    if (match[0].toLowerCase() === key) {
      // Casing follows each occurrence: ALL CAPS stays caps, Title stays title.
      out += applyCasing(match[0], suggestion);
      count++;
    } else {
      out += match[0];
    }
    cursor = match.index + match[0].length;
  }
  if (!count) return;
  commitHistory();
  textEl.value = out + value.slice(cursor);
  commitHistory();
  logReplacement(word, suggestion, count);
  setStatus(`«${word}» → «${suggestion}»${count > 1 ? ` (${count} удаа)` : ""} солигдлоо.`);
  fit();
  updateStats();
  scheduleCheck();
  textEl.focus();
}

function skipWord(word) {
  sessionSkipped.add(word.toLowerCase());
  misspellings = misspellings.filter((item) => item.toLowerCase() !== word.toLowerCase());
  setStatus(`«${word}» үгийг алгаслаа.`);
  paint();
}

function addToDictionary(word) {
  ignored.add(word.toLowerCase());
  storeIgnored();
  misspellings = misspellings.filter((item) => item.toLowerCase() !== word.toLowerCase());
  setStatus(`«${word}» үгийг тольд нэмлээ.`);
  paint();
}

function clearDictionary() {
  ignored = new Set();
  storeIgnored();
  setStatus("Тольд нэмсэн үгсийг цэвэрлэлээ.");
  runCheck();
}

async function fixAll() {
  if (!misspellings.length) return;
  commitHistory();
  let text = textEl.value;
  let fixedCount = 0;
  for (const word of [...misspellings]) {
    const list = await loadSuggestions(word);
    if (list && list.length > 0) {
      const best = list[0];
      const key = word.toLowerCase();
      let out = "";
      let cursor = 0;
      let count = 0;
      for (const match of text.matchAll(CYRILLIC)) {
        out += text.slice(cursor, match.index);
        if (match[0].toLowerCase() === key) {
          out += applyCasing(match[0], best);
          count++;
        } else {
          out += match[0];
        }
        cursor = match.index + match[0].length;
      }
      if (count) {
        text = out + text.slice(cursor);
        fixedCount++;
        logReplacement(word, best, count);
      }
    }
  }
  if (fixedCount > 0) {
    textEl.value = text;
    commitHistory();
    fit();
    updateStats();
    setStatus(`Бүх алдааг (${fixedCount}) эхний саналаар заслаа.`);
    runCheck();
  }
}

async function copyAll() {
  const value = textEl.value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    setStatus("Бүх текстийг санах ойд хууллаа.");
  } catch {
    setStatus("Текстийг хуулж чадсангүй.", "error");
  }
}

function downloadText() {
  const value = textEl.value;
  if (!value) return;
  const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "shalgasan-text.txt";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setStatus("Текстийг файл болгон татлаа.");
}

// ===== Case tools =====
const CASE_LABELS = {
  upper: "БҮГД ТОМ",
  lower: "бүгд жижиг",
  sentence: "Өгүүлбэрийн хэлбэр",
  title: "Үг бүрийн эх үсэг",
};

function transformCase(value, mode) {
  if (mode === "upper") return value.toUpperCase();
  if (mode === "lower") return value.toLowerCase();
  if (mode === "sentence") {
    // Lowercase everything, then lift the first letter of each sentence
    // (at the start, after . ! ? … or after a line break).
    return value
      .toLowerCase()
      .replace(/(^\s*|[.!?…]+\s+|\n\s*)([а-яёөү])/g, (_, lead, ch) => lead + ch.toUpperCase());
  }
  if (mode === "title") {
    return value.toLowerCase().replace(/([а-яёөүa-z])([а-яёөүa-z]*)/g, (_, first, rest) => first.toUpperCase() + rest);
  }
  return value;
}

// Applies to the selection, or to the whole text when nothing is selected.
function applyCase(mode) {
  const value = textEl.value;
  if (!value.trim() || !CASE_LABELS[mode]) return;
  const start = textEl.selectionStart;
  const end = textEl.selectionEnd;
  const hasSelection = end > start;
  const segment = hasSelection ? value.slice(start, end) : value;
  const next = transformCase(segment, mode);
  if (next === segment) {
    setStatus(`«${CASE_LABELS[mode]}» — өөрчлөх зүйл олдсонгүй.`);
    return;
  }
  commitHistory();
  textEl.value = hasSelection ? value.slice(0, start) + next + value.slice(end) : next;
  commitHistory();
  textEl.focus();
  if (hasSelection) textEl.setSelectionRange(start, start + next.length);
  fit();
  updateStats();
  runCheck();
  setStatus(
    hasSelection
      ? `Сонгосон хэсгийг «${CASE_LABELS[mode]}» болголоо.`
      : `Бүх текстийг «${CASE_LABELS[mode]}» болголоо.`
  );
}

// ===== Undo / redo history =====
function commitHistory() {
  if (histTimer) {
    clearTimeout(histTimer);
    histTimer = null;
  }
  const value = textEl.value;
  if (history[hIndex] === value) return;
  history = history.slice(0, hIndex + 1);
  history.push(value);
  if (history.length > 100) history.shift();
  hIndex = history.length - 1;
  updateHistButtons();
}

function scheduleHistory() {
  if (histTimer) clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    histTimer = null;
    commitHistory();
  }, 600);
}

function updateHistButtons() {
  undoBtn.disabled = hIndex <= 0;
  redoBtn.disabled = hIndex >= history.length - 1;
}

function applyHistory(index) {
  hIndex = index;
  textEl.value = history[hIndex];
  fit();
  updateStats();
  updateHistButtons();
  scheduleCheck();
}

function undo() {
  commitHistory();
  if (hIndex > 0) applyHistory(hIndex - 1);
}

function redo() {
  if (hIndex < history.length - 1) applyHistory(hIndex + 1);
}

// ===== File loading (.txt / .docx) =====
// DOCX is a ZIP with word/document.xml inside. Browsers can inflate raw
// deflate streams natively, so a minimal ZIP reader keeps this dependency-free.
async function unzipEntry(buffer, entryName) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (name === entryName) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method !== 8) throw new Error(`unsupported compression ${method}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error("word/document.xml not found");
}

async function docxToText(file) {
  const xml = new TextDecoder().decode(await unzipEntry(await file.arrayBuffer(), "word/document.xml"));
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphs = [];
  for (const p of doc.getElementsByTagName("w:p")) {
    let text = "";
    for (const t of p.getElementsByTagName("w:t")) text += t.textContent;
    paragraphs.push(text);
  }
  return paragraphs.join("\n");
}

async function loadFile(file) {
  if (!file) return;
  try {
    setStatus(`«${file.name}» уншиж байна…`);
    let text;
    if (/\.docx$/i.test(file.name)) {
      text = await docxToText(file);
    } else {
      text = await file.text();
    }
    text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error("empty file");
    commitHistory();
    textEl.value = text;
    commitHistory();
    setStatus(`«${file.name}» ачааллаа.`);
    fit();
    updateStats();
    runCheck();
    textEl.focus();
  } catch {
    setStatus("Файлыг уншиж чадсангүй. Зөвхөн .txt, .docx файл дэмжинэ.", "error");
  }
}
// ===== Menus =====
function closeMenus() {
  samplesMenu.hidden = true;
  samplesBtn.setAttribute("aria-expanded", "false");
  settingsMenu.hidden = true;
  settingsBtn.setAttribute("aria-expanded", "false");
}

function toggleMenu(menu, button) {
  const willOpen = menu.hidden;
  closeMenus();
  menu.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
}

function buildSamplesMenu() {
  samplesMenu.textContent = "";
  SAMPLES.forEach((sample, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu__item";
    item.textContent = sample.label;
    item.addEventListener("click", () => {
      loadSample(i);
      closeMenus();
    });
    samplesMenu.append(item);
  });
}

function loadSample(index = 0) {
  const sample = SAMPLES[index];
  if (!sample) return;
  commitHistory();
  textEl.value = sample.text;
  commitHistory();
  setStatus("");
  fit();
  updateStats();
  runCheck();
  textEl.focus();
}

// ===== Theme =====
function applyTheme(mode) {
  if (mode) document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  const dark = mode ? mode === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  themeToggle.checked = dark;
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {}
  applyTheme(stored === "dark" || stored === "light" ? stored : null);
}

// ===== Hover suggestion card =====
let hoverHideTimer = null;
let hoverWord = null;
let hoverDisplay = "";
let hoverRect = null;
let hoverToken = 0;
let lastHoverMark = null;
let hoverRaf = 0;
let hoverPoint = null;

function setHoverHighlight(word) {
  const key = word ? word.toLowerCase() : null;
  if (key === hoverWord) return;
  hoverWord = key;
  marksEl.querySelectorAll("mark.is-hover").forEach((el) => el.classList.remove("is-hover"));
  if (key) {
    for (const mark of marksEl.querySelectorAll("mark")) {
      if (mark.dataset.word.toLowerCase() === key) mark.classList.add("is-hover");
    }
  }
  padEl.classList.toggle("is-over-mark", !!key);
}

function hideHoverCard() {
  if (hoverHideTimer) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
  hoverPoint = null;
  hoverToken++;
  lastHoverMark = null;
  hoverRect = null;
  hoverDisplay = "";
  setHoverHighlight(null);
  hoverCardEl.hidden = true;
}

// Small grace period so the pointer can travel from the word onto the card.
function scheduleHoverHide() {
  if (hoverHideTimer) clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(() => {
    hoverHideTimer = null;
    hideHoverCard();
  }, 240);
}

function placeHoverCard(rect) {
  hoverCardEl.style.visibility = "hidden";
  hoverCardEl.hidden = false;
  const card = hoverCardEl.getBoundingClientRect();
  const gap = 8;
  const top =
    rect.bottom + gap + card.height > window.innerHeight - 8
      ? Math.max(8, rect.top - card.height - gap)
      : rect.bottom + gap;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - card.width / 2), window.innerWidth - card.width - 8);
  hoverCardEl.style.top = `${Math.round(top)}px`;
  hoverCardEl.style.left = `${Math.round(left)}px`;
  hoverCardEl.style.visibility = "";
}

async function fillHoverCard(word) {
  const token = ++hoverToken;
  hoverCardEl.hidden = false;
  hoverCardEl.textContent = "";
  const list = document.createElement("div");
  list.className = "rank";
  list.dataset.role = "ranks";
  const hint = document.createElement("div");
  hint.className = "rank__hint";
  hint.textContent = "Санал хайж байна…";
  list.append(hint);
  const actions = document.createElement("div");
  actions.className = "hovercard__actions";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "linkbtn";
  skip.dataset.action = "skip";
  skip.textContent = "Алгасах";
  const ignore = document.createElement("button");
  ignore.type = "button";
  ignore.className = "linkbtn";
  ignore.dataset.action = "ignore";
  ignore.textContent = "Тольд нэмэх";
  actions.append(skip, ignore);
  hoverCardEl.append(list, actions);
  if (hoverRect) placeHoverCard(hoverRect);
  const suggestions = await loadSuggestions(word);
  if (token !== hoverToken || hoverCardEl.hidden) return;
  list.textContent = "";
  if (!suggestions.length) {
    hint.textContent = "Санал олдсонгүй.";
    list.append(hint);
  } else {
    suggestions.slice(0, 6).forEach((suggestion, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = i === 0 ? "rank__item rank__item--best" : "rank__item";
      item.dataset.sug = suggestion;
      const no = document.createElement("span");
      no.className = "rank__no";
      no.textContent = String(i + 1);
      const label = document.createElement("span");
      label.className = "rank__word";
      label.textContent = suggestion;
      item.append(no, label);
      list.append(item);
    });
  }
  if (hoverRect && !hoverCardEl.hidden) placeHoverCard(hoverRect);
}

function showHoverFor(mark) {
  const word = mark.dataset.word;
  const rect = mark.getClientRects()[0];
  if (!rect) return;
  const sameWordShown = !hoverCardEl.hidden && hoverDisplay.toLowerCase() === word.toLowerCase();
  setHoverHighlight(word);
  hoverRect = rect;
  if (sameWordShown) {
    placeHoverCard(rect);
    return;
  }
  hoverDisplay = word;
  fillHoverCard(word);
}

function updateHover(x, y) {
  const mark = markAt(x, y);
  if (mark === lastHoverMark) {
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    return;
  }
  lastHoverMark = mark;
  if (!mark) {
    setHoverHighlight(null);
    scheduleHoverHide();
    return;
  }
  if (hoverHideTimer) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
  showHoverFor(mark);
}

// ===== Events =====
textEl.addEventListener("input", () => {
  hideHoverCard();
  fit();
  updateStats();
  scheduleHistory();
  scheduleCheck();
});
textEl.addEventListener("paste", () => {
  clearTimeout(debounce);
  setTimeout(runCheck, 0);
});
textEl.addEventListener("scroll", () => {
  hideHoverCard();
  marksEl.scrollTop = textEl.scrollTop;
  marksEl.scrollLeft = textEl.scrollLeft;
});

// Selecting a flagged word inside the textarea.
function selectWordInText(word) {
  const key = word.toLowerCase();
  for (const match of textEl.value.matchAll(CYRILLIC)) {
    if (match[0].toLowerCase() !== key) continue;
    textEl.focus();
    textEl.setSelectionRange(match.index, match.index + match[0].length);
    return;
  }
}

// Clicking/tapping a flagged word selects it and opens the ranked list
// (also the entry point on touch devices); clicking elsewhere closes it.
padEl.addEventListener("click", (event) => {
  const mark = markAt(event.clientX, event.clientY);
  if (!mark) {
    hideHoverCard();
    return;
  }
  selectWordInText(mark.dataset.word);
  lastHoverMark = mark;
  showHoverFor(mark);
});

// Hovering a flagged word highlights every occurrence and opens the quick
// suggestion card; rAF-throttled so dense documents stay smooth.
padEl.addEventListener("mousemove", (event) => {
  hoverPoint = { x: event.clientX, y: event.clientY };
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    if (hoverPoint) updateHover(hoverPoint.x, hoverPoint.y);
  });
});

padEl.addEventListener("mouseleave", scheduleHoverHide);

hoverCardEl.addEventListener("mouseenter", () => {
  if (hoverHideTimer) {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = null;
  }
});
hoverCardEl.addEventListener("mouseleave", scheduleHoverHide);
hoverCardEl.addEventListener("click", (event) => {
  const item = event.target.closest(".rank__item");
  if (item && item.dataset.sug && hoverDisplay) {
    replaceWord(hoverDisplay, item.dataset.sug);
    hideHoverCard();
    return;
  }
  const action = event.target.closest("[data-action]");
  if (!action || !hoverDisplay) return;
  if (action.dataset.action === "skip") skipWord(hoverDisplay);
  if (action.dataset.action === "ignore") addToDictionary(hoverDisplay);
  hideHoverCard();
});

checkBtn.addEventListener("click", () => runCheck());
if (copyAllBtn) copyAllBtn.addEventListener("click", copyAll);
if (downloadBtn) downloadBtn.addEventListener("click", downloadText);
if (fixAllBtn) fixAllBtn.addEventListener("click", fixAll);

clearBtn.addEventListener("click", () => {
  commitHistory();
  textEl.value = "";
  commitHistory();
  setStatus("");
  misspellings = [];
  sessionSkipped.clear();
  fit();
  updateStats();
  paint();
  textEl.focus();
});
sampleBtn.addEventListener("click", () => loadSample(0));
samplesBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu(samplesMenu, samplesBtn);
});
settingsBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMenu(settingsMenu, settingsBtn);
});
formatBarEl.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-case]");
  if (btn) applyCase(btn.dataset.case);
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".popwrap")) closeMenus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runCheck();
  }
});

undoBtn.addEventListener("click", undo);
redoBtn.addEventListener("click", redo);

themeToggle.addEventListener("change", () => {
  const mode = themeToggle.checked ? "dark" : "light";
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {}
  applyTheme(mode);
});
clearDictBtn.addEventListener("click", () => {
  clearDictionary();
  closeMenus();
});
clearHistoryBtn.addEventListener("click", () => {
  replaceLog = [];
  renderHistory();
  setStatus("Солилтын түүхийг цэвэрлэлээ.");
});

// File drop / picker.
dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-over");
  loadFile(event.dataTransfer?.files?.[0]);
});
fileInput.addEventListener("change", () => {
  loadFile(fileInput.files?.[0]);
  fileInput.value = "";
});

window.addEventListener("resize", () => {
  fit();
  hideHoverCard();
});

// ===== Init =====
buildSamplesMenu();
initTheme();
updateHistButtons();
updateStats();
paint();
renderHistory();
fit();
