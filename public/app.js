// ===== Refs =====
const padEl = document.getElementById("pad");
const textEl = document.getElementById("text");
const marksEl = document.getElementById("backdrop");
const statusEl = document.getElementById("status");
const statWordsEl = document.getElementById("stat-words");
const statCharsEl = document.getElementById("stat-chars");
const statSentencesEl = document.getElementById("stat-sentences");
const errCountEl = document.getElementById("err-count");
const copyAllBtn = document.getElementById("copy-all-btn");
const pasteBtn = document.getElementById("paste-btn");
const clearBtn = document.getElementById("clear-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const emptyEl = document.getElementById("empty");
const historyListEl = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");
const formatBarEl = document.getElementById("formatbar");
const editorEl = document.querySelector(".editor");
const settingsBtn = document.getElementById("settings-btn");
const settingsMenu = document.getElementById("settings-menu");
const themeToggle = document.getElementById("theme-toggle");
const clearDictBtn = document.getElementById("clear-dict");
const hoverCardEl = document.getElementById("hover-card");

const API = "/cms-client/modules/spellchecker";
const CYRILLIC = /[\u0400-\u04FF]+/g;
const STORAGE_KEY = "sc-ignored-v1";
const THEME_KEY = "sc-theme-v1";

// ===== State =====
let ignored = new Set(readStored());
let sessionSkipped = new Set();
let misspellings = [];
let replaceLog = [];
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
  statWordsEl.textContent = `${formatNum(words)} үг`;
  statCharsEl.textContent = `${formatNum(chars)} тэмдэгт`;
  if (statSentencesEl) statSentencesEl.textContent = `${formatNum(sentences)} өгүүлбэр`;
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

// The textarea owns the scroll; the clipped backdrop has to follow it. This must
// also run after a repaint: a caret-driven scroll (paste, fill) can land before
// the new marks exist, so the sync is clamped to 0 and would never be retried.
function syncScroll() {
  marksEl.scrollTop = textEl.scrollTop;
  marksEl.scrollLeft = textEl.scrollLeft;
}

function paintMarks(value, flagged) {
  let html = "";
  let cursor = 0;
  // --i is the stagger index the just-checked animation reuses.
  let i = 0;
  for (const match of value.matchAll(CYRILLIC)) {
    html += escapeHtmlLite(value.slice(cursor, match.index));
    const word = match[0];
    if (flagged.has(word.toLowerCase())) {
      html += `<mark data-word="${escapeHtmlLite(word)}" style="--i:${i++}">${escapeHtmlLite(word)}</mark>`;
    } else {
      html += escapeHtmlLite(word);
    }
    cursor = match.index + word.length;
  }
  marksEl.innerHTML = `${html}${escapeHtmlLite(value.slice(cursor))}\n`;
}

function paint() {
  hideHoverCard();
  pinnedMark = null;
  const value = textEl.value;
  const flagged = new Set(misspellings.map((word) => word.toLowerCase()));
  paintMarks(value, flagged);
  syncScroll();
  marksEl.classList.remove("just-checked");
  // Checking is automatic, so the live count is the standing proof that a check
  // ran. Every repaint keeps it honest (skip, dictionary, undo, clear).
  if (misspellings.length) {
    errCountEl.textContent = `${formatNum(misspellings.length)} алдаа`;
    errCountEl.hidden = false;
  } else {
    errCountEl.hidden = true;
  }
  // The panel lists the same words the marks do, so one repaint updates both.
  renderHistory();
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

// After every check the fresh marks pop in with a short stagger.
function flashResults() {
  if (!misspellings.length) return;
  marksEl.classList.remove("just-checked");
  void marksEl.offsetWidth;
  marksEl.classList.add("just-checked");
}

async function runCheck() {
  clearTimeout(debounce);
  const value = textEl.value;
  updateStats();
  if (!value.trim()) {
    requestId++;
    misspellings = [];
    setStatus("");
    paint();
    flashResults();
    return;
  }
  const id = ++requestId;
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
    // A successful check clears a stale connection error but keeps info messages
    // describing what just happened.
    if (statusIsError) setStatus("");
    paint();
    flashResults();
  } catch {
    if (id !== requestId) return;
    setStatus("Шалгаж чадсангүй. Серверт холбогдохгүй байна.", "error");
  }
}

// Cmd/Ctrl+Enter: re-check right away and say so. Suggestions are no longer
// primed here — the hover card fetches them on demand.
async function forceCheck() {
  // Remove + reflow restarts the sweep even on back-to-back presses.
  editorEl.classList.remove("is-scanning");
  void editorEl.offsetWidth;
  editorEl.classList.add("is-scanning");
  await runCheck();
  editorEl.classList.remove("is-scanning");
  if (statusIsError) return;
  if (misspellings.length) setStatus(`${formatNum(misspellings.length)} алдаа олдлоо.`);
  else if (textEl.value.trim()) setStatus("Алдаа олдсонгүй.");
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

// How many times a word is highlighted in the text right now.
function occurrenceCount(word) {
  const key = word.toLowerCase();
  let n = 0;
  for (const mark of marksEl.querySelectorAll("mark")) {
    if (mark.dataset.word.toLowerCase() === key) n++;
  }
  return n;
}

// A still-wrong word: click it to jump to the first occurrence.
function buildErrorRow(word) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "errrow";
  row.dataset.word = word;
  row.title = "Текст дэх үсгийг руу очих";
  const label = document.createElement("span");
  label.className = "errrow__word";
  label.textContent = word;
  row.append(label);
  const n = occurrenceCount(word);
  if (n > 1) {
    const count = document.createElement("span");
    count.className = "errrow__count";
    count.textContent = `×${n}`;
    row.append(count);
  }
  return row;
}

// The panel is one list: words that are still wrong first, then what each
// replaced word became.
function renderHistory() {
  historyListEl.textContent = "";
  emptyEl.hidden = misspellings.length > 0 || replaceLog.length > 0;
  for (const word of misspellings) historyListEl.append(buildErrorRow(word));
  for (let i = replaceLog.length - 1; i >= 0; i--) historyListEl.append(buildHistoryEntry(replaceLog[i]));
}

// Clicking a still-wrong word pins the hover look onto that one exact
// occurrence, and scrolls it into view if the pad has scrolled past it.
function focusWord(word) {
  const key = word.toLowerCase();
  const mark = [...marksEl.querySelectorAll("mark")].find((el) => el.dataset.word.toLowerCase() === key);
  if (!mark) return;
  scrollPadTo(mark);
  pinMark(mark);
  textEl.focus();
}

// The textarea is the real scroller, so nudge it — never the clipped backdrop.
function scrollPadTo(mark) {
  const pad = padEl.getBoundingClientRect();
  const box = mark.getBoundingClientRect();
  const offset = box.top - pad.top;
  if (offset >= 0 && offset <= textEl.clientHeight) return;
  textEl.scrollTop = Math.max(0, textEl.scrollTop + offset - textEl.clientHeight / 2);
}

// The pin is a separate class from .is-hover so real pointer movement can take
// over without the two fighting over the same nodes.
function pinMark(mark) {
  if (pinnedMark && pinnedMark !== mark) pinnedMark.classList.remove("is-pinned");
  pinnedMark = mark || null;
  if (pinnedMark) pinnedMark.classList.add("is-pinned");
}

function unpinMark() {
  if (!pinnedMark) return;
  pinnedMark.classList.remove("is-pinned");
  pinnedMark = null;
}
// ===== Suggestions =====
// Suggestions are fetched ONLY when the user explicitly runs the checker
// Suggestions are fetched when a word is hovered or tapped. The bounded cache
// keeps repeat hovers instant and the in-flight map deduplicates concurrent
// requests for the same word, so a document with hundreds of errors only ever
// costs one request per word the user actually points at.
const pendingSuggestions = new Map();

async function loadSuggestions(word) {
  if (suggestionCache.has(word)) return suggestionCache.get(word);
  if (pendingSuggestions.has(word)) return pendingSuggestions.get(word);
  const request = (async () => {
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
    } finally {
      pendingSuggestions.delete(word);
    }
  })();
  pendingSuggestions.set(word, request);
  return request;
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
  // The word is fixed now, so drop it from the live list immediately instead of
  // waiting for the re-check — the panel and the pill update in the same frame.
  misspellings = misspellings.filter((item) => item.toLowerCase() !== key);
  fit();
  updateStats();
  paint();
  logReplacement(word, suggestion, count);
  setStatus(`«${word}» → «${suggestion}»${count > 1 ? ` (${count} удаа)` : ""} солигдлоо.`);
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

// Paste lands at the caret (replacing any selection) rather than wiping the
// box, so it can be used mid-sentence.
async function pasteFromClipboard() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    setStatus("Хувийн ойг уншиж чадсангүй. ⌘/Ctrl + V дараад бичнэ үү.", "error");
    return;
  }
  if (!text) {
    setStatus("Хувийн ойн хоосон байна.");
    return;
  }
  const start = textEl.selectionStart ?? textEl.value.length;
  const end = textEl.selectionEnd ?? start;
  commitHistory();
  textEl.setRangeText(text, start, end, "end");
  commitHistory();
  setStatus("Хувийн ойноос буулгалаа.");
  fit();
  updateStats();
  runCheck();
  textEl.focus();
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
    // (at the start, after . ! ? … or after a line break). The class covers
    // Cyrillic AND Latin, so English sentences re-capitalize too.
    return value
      .toLowerCase()
      .replace(/(^\s*|[.!?…]+\s+|\n\s*)([а-яёөүa-z])/g, (_, lead, ch) => lead + ch.toUpperCase());
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

// ===== Menus =====
function closeMenus() {
  settingsMenu.hidden = true;
  settingsBtn.setAttribute("aria-expanded", "false");
}

function toggleMenu(menu, button) {
  const willOpen = menu.hidden;
  closeMenus();
  menu.hidden = !willOpen;
  button.setAttribute("aria-expanded", String(willOpen));
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
let pinnedMark = null;

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

  const render = (suggestions) => {
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
      // Candidates arrive with a short stagger, the same way marks pop in.
      if (token === hoverToken) list.classList.add("rank--in");
    }
    if (hoverRect && !hoverCardEl.hidden) placeHoverCard(hoverRect);
  };

  // Cache hit: instant, no request. Otherwise fetch once on demand —
  // loadSuggestions dedupes in-flight requests and remembers the answer, so a
  // second hover on the same word is instant too.
  if (suggestionCache.has(word)) {
    render(suggestionCache.get(word));
    return;
  }
  hint.textContent = "Санал хайж байна…";
  hint.classList.add("rank__hint--loading");
  const suggestions = await loadSuggestions(word);
  if (token !== hoverToken || hoverCardEl.hidden) return;
  hint.classList.remove("rank__hint--loading");
  render(suggestions);
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
  // The pointer has taken over from the panel pin.
  unpinMark();
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
  syncScroll();
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

if (copyAllBtn) copyAllBtn.addEventListener("click", copyAll);
if (pasteBtn) pasteBtn.addEventListener("click", pasteFromClipboard);
historyListEl.addEventListener("click", (event) => {
  const row = event.target.closest(".errrow");
  if (row) focusWord(row.dataset.word);
});

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
  if (event.key === "Escape") {
    closeMenus();
    unpinMark();
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    forceCheck();
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
  setStatus("Зассан үгсийн түүхийг цэвэрлэлээ.");
});

window.addEventListener("resize", () => {
  fit();
  hideHoverCard();
});

// ===== Landing =====
function initLanding() {
  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  const revealables = [...document.querySelectorAll(".reveal")];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!("IntersectionObserver" in window) || reduced) {
    revealables.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealables.forEach((el) => io.observe(el));
  }
}

// ===== Init =====
initLanding();
initTheme();
updateHistButtons();
updateStats();
paint();
renderHistory();
fit();
