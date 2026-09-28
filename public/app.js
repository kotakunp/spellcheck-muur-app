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
const cardsEl = document.getElementById("cards");
const allListEl = document.getElementById("all-list");
const emptyEl = document.getElementById("empty");
const emptyTitleEl = document.getElementById("empty-title");
const emptySubEl = document.getElementById("empty-sub");
const sugsCountEl = document.getElementById("sugs-count");
const allCountEl = document.getElementById("all-count");
const tabSugs = document.getElementById("tab-sugs");
const tabAll = document.getElementById("tab-all");
const sideBarEl = document.getElementById("side-bar");
const fixAllBtn = document.getElementById("fix-all-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsMenu = document.getElementById("settings-menu");
const themeToggle = document.getElementById("theme-toggle");
const clearDictBtn = document.getElementById("clear-dict");

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
let activeIndex = -1;
let currentTab = "sugs";
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

const ICON_CHEV_L = '<svg class="ic ic--14" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_CHEV_R = '<svg class="ic ic--14" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_ARROW_R = '<svg class="ic ic--14" viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const ICON_COPY =
  '<svg class="ic ic--14" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
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

function countOccurrences(word) {
  const key = word.toLowerCase();
  let count = 0;
  // Tokenize with the same rule the server and paintMarks use, so a "word"
  // here is always a full Cyrillic token (no lookbehind / property escapes).
  for (const token of textEl.value.match(CYRILLIC) || []) {
    if (token.toLowerCase() === key) count++;
  }
  return count;
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
  const value = textEl.value;
  const flagged = new Set(misspellings.map((word) => word.toLowerCase()));
  paintMarks(value, flagged);
  applyActive();
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
    activeIndex = -1;
    checking = false;
    setStatus("");
    paint();
    renderSide();
    return;
  }
  const id = ++requestId;
  checking = true;
  // Surface the loading state only when the sidebar has nothing to show yet,
  // so typing never makes existing cards flicker.
  if (!misspellings.length) renderSide();
  try {
    const res = await fetch(`${API}/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: value }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (id !== requestId) return;
    const prevWord = activeIndex >= 0 ? misspellings[activeIndex] : null;
    misspellings = data.filter((word) => !ignored.has(word.toLowerCase()) && !sessionSkipped.has(word.toLowerCase()));
    checking = false;
    const keep = prevWord ? misspellings.indexOf(prevWord) : -1;
    activeIndex = keep >= 0 ? keep : misspellings.length ? Math.min(Math.max(activeIndex, 0), misspellings.length - 1) : -1;
    // A successful check clears a stale connection error, but keeps info messages
    // such as "«file.txt» ачааллаа." that describe what just happened.
    if (statusIsError) setStatus("");
    paint();
    renderSide();
  } catch {
    if (id !== requestId) return;
    checking = false;
    setStatus("Шалгаж чадсангүй. Серверт холбогдохгүй байна.", "error");
  }
}

// ===== Sidebar =====
function renderSide() {
  const total = misspellings.length;
  sugsCountEl.textContent = total;
  allCountEl.textContent = total;
  cardsEl.textContent = "";
  allListEl.textContent = "";
  if (sideBarEl) sideBarEl.hidden = currentTab !== "sugs" || !total;
  if (!total) {
    emptyEl.hidden = false;
    if (checking) {
      emptyTitleEl.textContent = "Шалгаж байна…";
      emptySubEl.textContent = "Түр хүлээнэ үү.";
    } else if (textEl.value.trim()) {
      emptyTitleEl.textContent = "Алдаа олдсонгүй";
      emptySubEl.textContent = "Бүх үг зөв бичигдсэн байна.";
    } else {
      emptyTitleEl.textContent = "Текст бичнэ үү";
      emptySubEl.textContent = "Эсвэл жишээ текст сонгоорой.";
    }
    cardsEl.hidden = true;
    allListEl.hidden = true;
    return;
  }
  emptyEl.hidden = true;
  // Drop suggestion work still queued for the previous render; each card that
  // survives a re-render is queued again with its fresh index.
  suggestQueue.length = 0;
  misspellings.forEach((word, index) => {
    cardsEl.append(buildCard(word, index, total));
    allListEl.append(buildRow(word, index, total));
  });
  cardsEl.hidden = currentTab !== "sugs";
  allListEl.hidden = currentTab !== "all";
  applyActive();
  misspellings.forEach((word, index) => queueSuggestions(word, index));
}

function buildCard(word, index, total) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.word = word;
  card.dataset.index = index;

  const head = document.createElement("div");
  head.className = "card__head";
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.textContent = word;
  const nav = document.createElement("div");
  nav.className = "card__nav";
  const count = document.createElement("span");
  count.className = "card__count";
  count.textContent = `${index + 1} / ${total}`;
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "navbtn";
  prev.title = "Өмнөх алдаа";
  prev.setAttribute("aria-label", "Өмнөх алдаа");
  prev.dataset.nav = "-1";
  prev.innerHTML = ICON_CHEV_L;
  const next = document.createElement("button");
  next.type = "button";
  next.className = "navbtn";
  next.title = "Дараагийн алдаа";
  next.setAttribute("aria-label", "Дараагийн алдаа");
  next.dataset.nav = "1";
  next.innerHTML = ICON_CHEV_R;
  nav.append(count, prev, next);
  head.append(pill, nav);

  const chips = document.createElement("div");
  chips.className = "chips";
  chips.dataset.role = "chips";
  const pending = document.createElement("span");
  pending.className = "card__hint";
  pending.textContent = "Санал хайж байна…";
  chips.append(pending);

  const explain = document.createElement("div");
  explain.className = "card__explain";
  explain.dataset.role = "explain";
  explain.hidden = true;

  const meta = document.createElement("div");
  meta.className = "card__meta";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "linkbtn";
  skip.dataset.role = "skip";
  skip.textContent = "Алгасах";
  const ignore = document.createElement("button");
  ignore.type = "button";
  ignore.className = "linkbtn";
  ignore.dataset.role = "ignore";
  ignore.textContent = "Тольд нэмэх";
  meta.append(skip, ignore);

  card.append(head, chips, explain, meta);
  return card;
}

function buildRow(word, index, total) {
  const row = document.createElement("div");
  row.className = "allrow";
  row.dataset.word = word;
  row.dataset.index = index;
  const label = document.createElement("span");
  label.className = "allrow__word";
  label.textContent = word;
  const occurrences = countOccurrences(word);
  const count = document.createElement("span");
  count.className = "allrow__count";
  count.textContent = `${occurrences} удаа / ${total} алдаанаас`;
  const goto = document.createElement("button");
  goto.type = "button";
  goto.className = "allrow__goto";
  goto.title = "Карт руу очих";
  goto.setAttribute("aria-label", "Карт руу очих");
  goto.dataset.role = "goto";
  goto.innerHTML = ICON_ARROW_R;
  row.append(label, count, goto);
  return row;
}
// ===== Suggestions =====
// Suggestions are fetched with a small concurrency limit so a document with
// hundreds of errors does not fire hundreds of parallel requests at once.
const suggestQueue = [];
let suggestActive = 0;
const SUGGEST_CONCURRENCY = 4;

function queueSuggestions(word, index) {
  suggestQueue.push({ word, index });
  pumpSuggestions();
}

function pumpSuggestions() {
  while (suggestActive < SUGGEST_CONCURRENCY && suggestQueue.length) {
    const job = suggestQueue.shift();
    suggestActive++;
    fillSuggestions(job.word, job.index).finally(() => {
      suggestActive--;
      pumpSuggestions();
    });
  }
}

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

async function fillSuggestions(word, index) {
  const list = await loadSuggestions(word);
  const card = cardsEl.querySelector(`.card[data-index="${index}"]`);
  if (!card || card.dataset.word !== word) return;
  const chips = card.querySelector('[data-role="chips"]');
  const explain = card.querySelector('[data-role="explain"]');
  chips.textContent = "";
  if (!list.length) {
    const hint = document.createElement("span");
    hint.className = "card__hint";
    hint.textContent = "Санал олдсонгүй. Тольд нэмэх эсвэл гараар засна уу.";
    chips.append(hint);
    explain.hidden = true;
    return;
  }
  list.slice(0, 6).forEach((suggestion, i) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = i === 0 ? "chip chip--best" : "chip";
    chip.dataset.sug = suggestion;
    chip.textContent = suggestion;
    if (i === 0) {
      const enter = document.createElement("span");
      enter.className = "chip__enter";
      enter.textContent = "↵";
      chip.append(enter);
      chip.title = "Эхний санал — Enter товч";
    }
    chips.append(chip);
  });
  explain.hidden = false;
  explain.textContent = "";
  const body = document.createElement("div");
  body.className = "card__explain-body";
  const label = document.createElement("p");
  label.className = "card__explain-label";
  label.textContent = "тайлбар";
  const text = document.createElement("p");
  text.className = "card__explain-text";
  const first = document.createElement("b");
  first.textContent = `«${list[0]}»`;
  text.append(first, ` нь зөв бичлэг юм. «${word}» үгийг солих бол дээрх саналыг сонгоно уу.`);
  body.append(label, text);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copybtn";
  copy.title = "Зөв үгийг хуулах";
  copy.setAttribute("aria-label", "Зөв үгийг хуулах");
  copy.dataset.role = "copy";
  copy.dataset.sug = list[0];
  copy.innerHTML = ICON_COPY;
  body.append(text, copy);
  explain.append(label, body);
}

// ===== Active error navigation =====
function applyActive() {
  cardsEl.querySelectorAll(".card.is-active").forEach((el) => el.classList.remove("is-active"));
  allListEl.querySelectorAll(".allrow.is-active").forEach((el) => el.classList.remove("is-active"));
  marksEl.querySelectorAll("mark.is-active").forEach((el) => el.classList.remove("is-active"));
  if (activeIndex < 0) return;
  const word = misspellings[activeIndex];
  if (!word) return;
  const card = cardsEl.querySelector(`.card[data-index="${activeIndex}"]`);
  if (card) card.classList.add("is-active");
  const row = allListEl.querySelector(`.allrow[data-index="${activeIndex}"]`);
  if (row) row.classList.add("is-active");
  for (const mark of marksEl.querySelectorAll("mark")) {
    if (mark.dataset.word.toLowerCase() === word.toLowerCase()) mark.classList.add("is-active");
  }
}

function setActive(index, { scrollText = false, scrollCard = true } = {}) {
  if (!misspellings.length) return;
  activeIndex = Math.min(Math.max(index, 0), misspellings.length - 1);
  applyActive();
  const word = misspellings[activeIndex];
  if (scrollText) scrollToWord(word);
  if (scrollCard) {
    const card = cardsEl.querySelector(`.card[data-index="${activeIndex}"]`);
    card?.scrollIntoView({ block: "nearest" });
  }
}

function scrollToWord(word) {
  for (const mark of marksEl.querySelectorAll("mark")) {
    if (mark.dataset.word.toLowerCase() !== word.toLowerCase()) continue;
    const rect = mark.getClientRects()[0];
    if (!rect) continue;
    const padRect = padEl.getBoundingClientRect();
    const visible = rect.top >= padRect.top && rect.bottom <= padRect.bottom;
    if (visible) return;
    textEl.scrollTop += rect.top - padRect.top - 60;
    return;
  }
}

function selectWordInText(word) {
  const key = word.toLowerCase();
  for (const match of textEl.value.matchAll(CYRILLIC)) {
    if (match[0].toLowerCase() !== key) continue;
    textEl.focus();
    textEl.setSelectionRange(match.index, match.index + match[0].length);
    return;
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
  let changed = false;
  for (const match of value.matchAll(CYRILLIC)) {
    out += value.slice(cursor, match.index);
    if (match[0].toLowerCase() === key) {
      // Casing follows each occurrence: ALL CAPS stays caps, Title stays title.
      out += applyCasing(match[0], suggestion);
      changed = true;
    } else {
      out += match[0];
    }
    cursor = match.index + match[0].length;
  }
  if (!changed) return;
  commitHistory();
  textEl.value = out + value.slice(cursor);
  commitHistory();
  fit();
  updateStats();
  scheduleCheck();
  textEl.focus();
}

function skipWord(word) {
  sessionSkipped.add(word.toLowerCase());
  misspellings = misspellings.filter((item) => item.toLowerCase() !== word.toLowerCase());
  if (activeIndex >= misspellings.length) activeIndex = misspellings.length - 1;
  setStatus(`«${word}» үгийг алгаслаа.`);
  paint();
  renderSide();
}

function addToDictionary(word) {
  ignored.add(word.toLowerCase());
  storeIgnored();
  misspellings = misspellings.filter((item) => item.toLowerCase() !== word.toLowerCase());
  if (activeIndex >= misspellings.length) activeIndex = misspellings.length - 1;
  setStatus(`«${word}» үгийг тольд нэмлээ.`);
  paint();
  renderSide();
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
      let replaced = false;
      for (const match of text.matchAll(CYRILLIC)) {
        out += text.slice(cursor, match.index);
        if (match[0].toLowerCase() === key) {
          out += applyCasing(match[0], best);
          replaced = true;
        } else {
          out += match[0];
        }
        cursor = match.index + match[0].length;
      }
      if (replaced) {
        text = out + text.slice(cursor);
        fixedCount++;
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

// ===== Tabs =====
function setTab(tab) {
  currentTab = tab;
  const sugs = tab === "sugs";
  tabSugs.classList.toggle("is-active", sugs);
  tabAll.classList.toggle("is-active", !sugs);
  tabSugs.setAttribute("aria-selected", String(sugs));
  tabAll.setAttribute("aria-selected", String(!sugs));
  const hasErrors = misspellings.length > 0;
  cardsEl.hidden = !sugs || !hasErrors;
  allListEl.hidden = sugs || !hasErrors;
  emptyEl.hidden = hasErrors;
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

// ===== Events =====
textEl.addEventListener("input", () => {
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
  marksEl.scrollTop = textEl.scrollTop;
  marksEl.scrollLeft = textEl.scrollLeft;
});

// Clicking a flagged word in the text activates its card.
padEl.addEventListener("click", (event) => {
  const mark = markAt(event.clientX, event.clientY);
  if (!mark) return;
  const word = mark.dataset.word;
  const index = misspellings.findIndex((item) => item.toLowerCase() === word.toLowerCase());
  if (index < 0) return;
  selectWordInText(word);
  setActive(index, { scrollText: false });
});

// Card interactions: suggestion chips, ignore, copy, prev/next navigation.
cardsEl.addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  if (!card) return;
  const index = Number(card.dataset.index);
  const target = event.target.closest("button");
  if (!target) {
    setActive(index, { scrollText: true });
    return;
  }
  if (target.dataset.role === "copy") {
    navigator.clipboard?.writeText(target.dataset.sug);
    setStatus(`«${target.dataset.sug}» үгийг хууллаа.`);
    return;
  }
  if (target.dataset.sug) {
    replaceWord(card.dataset.word, target.dataset.sug);
    return;
  }
  if (target.dataset.role === "skip") {
    skipWord(card.dataset.word);
    return;
  }
  if (target.dataset.role === "ignore") {
    addToDictionary(card.dataset.word);
    return;
  }
  if (target.dataset.nav) {
    setActive(index + Number(target.dataset.nav), { scrollText: true });
    return;
  }
  setActive(index, { scrollText: true });
});

// Rows in the "Бүх алдаа" tab jump to the matching card.
allListEl.addEventListener("click", (event) => {
  const row = event.target.closest(".allrow");
  if (!row) return;
  const index = Number(row.dataset.index);
  if (event.target.closest('[data-role="goto"]')) setTab("sugs");
  selectWordInText(row.dataset.word);
  // setActive scrolls both the text pad and the matching card into view.
  setActive(index, { scrollText: true });
});

tabSugs.addEventListener("click", () => setTab("sugs"));
tabAll.addEventListener("click", () => setTab("all"));

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
  activeIndex = -1;
  fit();
  updateStats();
  paint();
  renderSide();
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

window.addEventListener("resize", fit);

// ===== Init =====
buildSamplesMenu();
initTheme();
updateHistButtons();
updateStats();
paint();
renderSide();
fit();
