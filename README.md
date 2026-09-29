# spellcheck-mn-local

Private drop-in replacement for the `spellcheck.mn` (Болорспелл) check/suggest API — **no rate limits**, self-hosted, backed by the open Hunspell Mongolian dictionary (dict-mn `2026.09.21`).

## Quick start

```sh
npm install
npm start          # http://127.0.0.1:3456  (PORT / HOST env to change; defaults to 127.0.0.1)
npm test           # 33 API + static-route assertions
npm run ui         # 151 Playwright assertions on the UI, writes scripts/shots/*.png
```

## Web UI

One page for both the marketing site and the tool: sticky nav → hero title → **the live app inside a browser-style frame** (the "screenshot" section is the actual working editor, not an image) → feature grid → 3-step how-it-works → CTA band → footer, all in `public/index.html`. Sections reveal on scroll with staggered fade/slide animations, menus and the hover card pop in, the newest replacement slides into the history panel, and every animation is disabled under `prefers-reduced-motion`.

`http://localhost:3456/` — type or paste your text and press **Алдаа шалгах**; every misspelling is highlighted at once, hover (or tap) one for ranked candidates, and the sidebar keeps a log of every replacement.

- **Highlight everything at once** — every misspelled word in the document is highlighted simultaneously (soft red tint + wavy underline); the word under the pointer gets a stronger tint across all of its occurrences.
- **Hover / tap candidates** — hovering (or clicking/tapping) a misspelled word opens a compact ranked list of up to 6 candidates right next to it — just the candidates, no explanations. Candidates are fetched **only when you press Алдаа шалгах** (or ⌘/Ctrl + ↵) and open instantly from the cache afterwards; hover and tap never send requests, and until the first check the card shows a prompt instead. Click one to replace **every** occurrence at once, keeping each occurrence's own casing (`Уланбаатар → Улаанбаатар`, `УЛАНБААТАР → УЛААНБААТАР`, `уланбаатар → улаанбаатар`). The card also offers *Алгасах* and *Тольд нэмэх*.
- **Солилтын түүх (replacement history)** — the sidebar logs every replacement as `wrong → right` with per-occurrence `×n` counts and a timestamp; *Цэвэрлэх* empties the log. Session-only, never leaves the browser.
- **Хэлбэр (case tools under the input)** — four buttons apply **БҮГД ТОМ** (UPPERCASE), **бүгд жижиг** (lowercase), **Өгүүлбэрийн хэлбэр** (Sentence case) or **Үг бүрийн эх үсэг** (Title Case) to the selected text — or to the whole text when nothing is selected. Each transform is undoable, preserves the selection, and re-checks automatically.
- **Алдаа шалгах feedback** — the button swaps its sparkle for a spinner and a light sweep crosses the text while the request is in flight; when the answer arrives the flagged words pop in one by one (a short stagger) and the status line reports how many errors were found (`3 алдаа олдлоо.` / `Алдаа олдсонгүй.`).
- **Алгасах & Тольд нэмэх** — available on the hover card: *Алгасах* skips the error for the current session; *Тольд нэмэх* adds the word permanently to your personal dictionary (stored in browser `localStorage`); *Тохиргоо → Тольд нэмсэн үгсийг цэвэрлэх* resets it.
- **Хуулах / Татах** — 1-click clipboard copy of the entire text and direct export as a `.txt` file.
- **Stats** — live word, character, and sentence counts.
- **Буцаах / Дахин хийх** — undo/redo for edits and replacements (last 100 states).
- **Цэвэрлэх** empties the box, `⌘/Ctrl + ↵` forces a check, `Esc` closes menus.
- **Theme** — *Тохиргоо → Харанхуй горим* switches light/dark (remembered in `localStorage`, defaults to your OS setting).
- No build step, no client framework — three static files in `public/`.

## API (same shapes as spellcheck.mn)

| Endpoint | Body | Response |
|---|---|---|
| `POST /cms-client/modules/spellchecker/check` | `{text, key?}` | `["монгл", ...]` — misspelled Cyrillic words, deduped |
| `POST /cms-client/modules/spellchecker/suggest` | `{word, key?}` | `["монгол", ...]` — up to 10 suggestions |
| `POST /cms-client/modules/spellchecker/replace` | `{source, target}` | `{}` (no-op, kept for client compat) |
| `GET /healthz` | — | service/engine (with bundled dictionary version)/rate-limit info |

Notes on parity with the original:

- `key` is accepted and **ignored** (the original's key is a secretless SHA-256 of the text — nothing to enforce).
- Only Cyrillic tokens are checked; Latin/numbers are skipped (matches observed original behavior).
- No errors → `[]`, which the original frontend treats as "all good".
- No auth, no `403`/`Retry-After` — request as much as you want.
- CORS enabled for all origins (browser clients can switch base URL directly).

### Switch your client over

Point the base URL at your instance instead of `https://spellcheck.mn`:

```sh
SPELLCHECK_BASE=http://your-host:3456
```

```js
// before
await fetch("https://spellcheck.mn/cms-client/modules/spellchecker/check", ...)
// after
await fetch(`${BASE}/cms-client/modules/spellchecker/check`, ...)
```

## Hosting on Dokploy (Nixpacks)

The repo ships a `nixpacks.toml`, so Dokploy's Nixpacks provider builds and runs it as-is (`npm ci --omit=dev`, then `node server.js`) — the Playwright dev dependency is never installed in the image.

1. Dokploy → create a project → **Application** → provider **Nixpacks** → point it at this repo (`main`).
2. Environment variables:
   - `HOST=0.0.0.0` — **required**: the server otherwise binds `127.0.0.1`, unreachable from Traefik.
   - `PORT=3000` — any port works; match it in the app's routing/domain settings.
3. Set the app's port (and domain target, if any) to `3000`, then deploy.
4. Health check: `GET /healthz`.

Heads-up: this instance is intentionally auth-free and rate-limit-free — on a public domain, strangers can use it. If that matters, put it behind an auth proxy or add your own limits.

## How it works

- **Engine**: [hunspell-asm](https://github.com/kwonoj/hunspell-asm) — real Hunspell compiled to WebAssembly (no native build step, loads in ~600ms with the full dictionary).
- **Dictionary**: dict-mn by Batmunkh Dorjgotov, vendored into `words/` from the [bataak/dict-mn](https://github.com/bataak/dict-mn) release `2026.09.21` — 621k Mongolian word forms, `mn_MN.aff` with 4,198 REP rules + TRY alphabet, MPL-2.0.
- **Supplement**: the dictionary still misses some modern terminology and common postposition/inflected forms (`руу`, `рүү`, `компьютертэй`, `чат`, `интернэт`, `апп`, `вэб`, …). `words/supplement.txt` lists verified valid words compliant with standard Mongolian Cyrillic orthography. Those words are never flagged, *and* the suggestion engine may propose them. Each user can also extend their own list privately from the UI (**Тольд нэмэх**).
- **Suggestion strategy**: hunspell's ngram phase alone can miss direct fixes for single-edit mistakes, so the server generates single-edit neighbours (duplicate deletions, deletions, transpositions, substitutions, and insertions with TRY letters and title-case support), verifies each against the dictionary, and ranks them ahead of the ngram tail. Common typos like `монгл → монгол`, `саайн → сайн`, `тээвэрээр → тээврээр`, `хүүнтэй → хүнтэй`, and `Уланбаатар → Улаанбаатар` come out first.
- **Suggestion tuning**: appends `MAXNGRAMSUGS 10` / `MAXDIFF 10` to the aff so the hunspell tail comes back rich instead of terse.
- `nspell` (pure-JS hunspell) was tried first and is incompatible with dict-mn: it pre-expands every affix combination into one JS object and hits V8's property-count limit.
- `npm` overrides pin `nanoid` to a patched version, and `scripts/patch-nanoid.cjs` (postinstall) adjusts hunspell-asm's import of it — `npm audit` stays at 0 vulnerabilities.

### Updating the dictionary

`words/mn_MN.aff` + `words/mn_MN.dic` are pinned to a [bataak/dict-mn](https://github.com/bataak/dict-mn/tags) release tag (currently `2026.09.21`); the server prints the bundled version on startup and `/healthz` reports it in `engine`. To move to a newer release:

```sh
TAG=2026.09.21
curl -fsSL -o words/mn_MN.aff "https://raw.githubusercontent.com/bataak/dict-mn/$TAG/mn_MN/mn_MN.aff"
curl -fsSL -o words/mn_MN.dic "https://raw.githubusercontent.com/bataak/dict-mn/$TAG/mn_MN/mn_MN.dic"
curl -fsSL -o words/LICENSE   "https://raw.githubusercontent.com/bataak/dict-mn/main/LICENSE"
npm test                       # 33 assertions, then `npm run ui`
```

Note: releases up to `2026.09.07` were LPPL-1.3c; `2026.09.21` and later are MPL-2.0 (the `LICENSE` file at the `2026.09.21` tag lagged behind the file headers, so the header inside `mn_MN.aff` is authoritative).

## Known differences vs spellcheck.mn

- Dictionary contents differ (Bolorspell's dictionary is proprietary) → occasional words flagged by one but not the other, and suggestion tails differ. Top suggestions agree (`монгл` → `монгол` on both).
- `GET /cms-client/modules/spellchecker/today` (word-of-the-day), auth/login, billing and CMS endpoints are not implemented — not needed for check/suggest.
- `suggest` on a correctly spelled word returns `[]`.

## Licenses

- Server code: MIT
- dict-mn (`words/mn_MN.aff`, `words/mn_MN.dic`): MPL-2.0 for `2026.09.21` and later; releases up to `2026.09.07` were LPPL-1.3c. Keep the original copyright notices and license (`words/LICENSE`) when redistributing the dictionary files.
- hunspell-asm: MPL-2.0
