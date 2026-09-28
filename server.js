import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadModule } from "hunspell-asm";

const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_BODY = 5 * 1024 * 1024;
const SUGGEST_LIMIT = 10;
const CYRILLIC = /[\u0400-\u04FF]+/g;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const started = Date.now();
const factory = await loadModule();
// Vendored from bataak/dict-mn release 2026.09.21 (MPL-2.0) — see words/LICENSE.
const aff = await readFile(new URL("./words/mn_MN.aff", import.meta.url));
const dic = await readFile(new URL("./words/mn_MN.dic", import.meta.url));

// dict-mn's aff ships solid REP/TRY rules; these two hunspell directives
// widen the ngram suggestion pass so lists come back closer to 10 entries.
const affText = Buffer.from(aff).toString("utf8");
const DICT_VERSION = affText.match(/^# Version: (.+)$/m)?.[1] ?? "unknown";
const tunedAff = Buffer.concat([Buffer.from(aff), Buffer.from("\nMAXNGRAMSUGS 10\nMAXDIFF 10\n")]);
const affPath = factory.mountBuffer(tunedAff, "mn_MN.aff");
const dicPath = factory.mountBuffer(dic, "mn_MN.dic");
const hunspell = factory.create(affPath, dicPath);

const TRY_LETTERS = [...new Set((affText.match(/^TRY (.+)$/m)?.[1] ?? "").toLowerCase())];
const MAX_EDIT_LENGTH = 16;

const publicDir = new URL("./public/", import.meta.url);
const staticFiles = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/favicon.svg", { file: "favicon.svg", type: "image/svg+xml" }],
]);
const staticAssets = new Map();
for (const [route, { file, type }] of staticFiles) {
  const body = await readFile(new URL(file, publicDir));
  const etag = `"${createHash("md5").update(body).digest("hex")}"`;
  staticAssets.set(route, { body, type, etag });
}

const supplement = new Set(
  (await readFile(new URL("./words/supplement.txt", import.meta.url), "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
);

function isSpelled(word) {
  const lower = word.toLowerCase();
  if (supplement.has(lower)) return true;
  if (hunspell.spell(word)) return true;
  if (word !== lower && hunspell.spell(lower)) return true;
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  if (word !== title && hunspell.spell(title)) return true;
  return false;
}

function findMisspellings(text) {
  const found = [];
  const seen = new Set();
  for (const word of text.match(CYRILLIC) || []) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isSpelled(word)) found.push(word);
  }
  return found;
}

function editVariants(word) {
  const letters = [...word.toLowerCase()];
  const size = letters.length;
  const dedupDeletions = [];
  const deletions = [];
  const transpositions = [];
  const substitutions = [];
  const insertions = [];

  for (let i = 0; i < size; i++) {
    if (size > 2) {
      const v = letters.slice(0, i).join("") + letters.slice(i + 1).join("");
      if ((i > 0 && letters[i] === letters[i - 1]) || (i < size - 1 && letters[i] === letters[i + 1])) {
        dedupDeletions.push(v);
      } else {
        deletions.push(v);
      }
    }
  }

  for (let i = 0; i < size - 1; i++) {
    if (letters[i] !== letters[i + 1]) {
      transpositions.push(
        letters.slice(0, i).join("") + letters[i + 1] + letters[i] + letters.slice(i + 2).join("")
      );
    }
  }

  if (size <= MAX_EDIT_LENGTH) {
    for (let i = 0; i < size; i++) {
      const prefix = letters.slice(0, i).join("");
      const suffix = letters.slice(i + 1).join("");
      for (const letter of TRY_LETTERS) {
        if (letter !== letters[i]) {
          substitutions.push(prefix + letter + suffix);
        }
      }
    }
  }

  if (size <= 14) {
    for (let i = 0; i <= size; i++) {
      const prefix = letters.slice(0, i).join("");
      const suffix = letters.slice(i).join("");
      for (const letter of TRY_LETTERS) {
        insertions.push(prefix + letter + suffix);
      }
    }
  }

  const candidates = [...new Set([...dedupDeletions, ...deletions, ...transpositions, ...substitutions, ...insertions])];
  return candidates.filter((variant) => isSpelled(variant));
}

function applyCasing(source, target) {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return target.toUpperCase();
  }
  if (source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase();
  }
  return target.toLowerCase();
}

function buildSuggestions(word) {
  if (isSpelled(word)) return [];
  const source = word.toLowerCase();
  const seen = new Set([source]);
  const out = [];
  const push = (raw) => {
    const key = raw.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(applyCasing(word, raw));
    }
    return out.length < SUGGEST_LIMIT;
  };

  if ([...word].length >= 3) {
    const variants = editVariants(word);
    for (const variant of [...variants.filter((v) => supplement.has(v)), ...variants.filter((v) => !supplement.has(v))]) {
      if (!push(variant)) return out;
    }
  }
  for (const raw of hunspell.suggest(word)) {
    if (!push(raw)) break;
  }
  return out;
}

function json(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    ...CORS,
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const t0 = Date.now();
  const { pathname } = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let status = 200;

  try {
    if (req.method === "OPTIONS") {
      status = 204;
      res.writeHead(204, CORS);
      res.end();
    } else if (req.method === "GET" && staticAssets.has(pathname)) {
      const { body, type, etag } = staticAssets.get(pathname);
      if (req.headers["if-none-match"] === etag) {
        status = 304;
        res.writeHead(304, { etag, ...CORS });
        res.end();
      } else {
        res.writeHead(200, {
          "content-type": type,
          "content-length": body.length,
          "cache-control": "no-cache",
          etag,
          ...CORS,
        });
        res.end(body);
      }
    } else if (req.method === "GET" && pathname === "/healthz") {
      json(res, 200, {
        service: "spellcheck-mn-local",
        endpoints: [
          "GET  /",
          "POST /cms-client/modules/spellchecker/check {text}",
          "POST /cms-client/modules/spellchecker/suggest {word}",
          "POST /cms-client/modules/spellchecker/replace {source,target}",
        ],
        engine: `hunspell-asm + dict-mn ${DICT_VERSION}`,
        rateLimit: null,
      });
    } else if (req.method === "POST" && pathname === "/cms-client/modules/spellchecker/check") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        status = 400;
        return json(res, 400, { error: "invalid JSON" });
      }
      if (typeof body?.text !== "string") {
        status = 400;
        return json(res, 400, { error: "text must be a string" });
      }
      json(res, 200, findMisspellings(body.text));
    } else if (req.method === "POST" && pathname === "/cms-client/modules/spellchecker/suggest") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        status = 400;
        return json(res, 400, { error: "invalid JSON" });
      }
      if (typeof body?.word !== "string") {
        status = 400;
        return json(res, 400, { error: "word must be a string" });
      }
      json(res, 200, buildSuggestions(body.word));
    } else if (req.method === "POST" && pathname === "/cms-client/modules/spellchecker/replace") {
      await readBody(req);
      json(res, 200, {});
    } else {
      status = 404;
      json(res, 404, { error: "not found" });
    }
  } catch (err) {
    status = err.status || 500;
    json(res, status, { error: err.message || "internal error" });
  } finally {
    console.log(`${req.method} ${pathname} ${status} ${Date.now() - t0}ms`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`spellcheck-mn-local ready in ${Date.now() - started}ms`);
  console.log(`  http://127.0.0.1:${PORT}/  (listening on ${HOST})`);
  console.log(`  no rate limits · engine: hunspell-asm + dict-mn ${DICT_VERSION}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    try {
      hunspell.dispose();
    } catch {}
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
