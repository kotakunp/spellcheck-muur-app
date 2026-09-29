import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.TEST_PORT || 3999);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail !== undefined ? " -> " + JSON.stringify(detail) : ""}`);
  }
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json(), headers: res.headers };
}

async function waitForReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE + "/");
      if (res.ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error("server did not start");
}

await waitForReady();

const typo = await post("/cms-client/modules/spellchecker/check", {
  text: "Сайн байна уу? Би монгл хэлээр бичээд байна.",
  key: "ignored-garbage",
});
assert("typo text flags монгл", typo.status === 200 && typo.data.includes("монгл"), typo.data);
assert("correct words not flagged", !typo.data.some((w) => /сайн|байна|бичээд/i.test(w)), typo.data);
assert("accepts bogus key field", typo.status === 200);

const clean = await post("/cms-client/modules/spellchecker/check", {
  text: "Энэ нь цэвэр Монгол өгүүлбэр юм.",
});
assert("clean text returns []", clean.status === 200 && Array.isArray(clean.data) && clean.data.length === 0, clean.data);

const supplemented = await post("/cms-client/modules/spellchecker/check", {
  text: "Би шинэ компьютертэй болсон тул автобусаар явж, интернэт сүлжээнд холбогдон шинэ апп руу орлоо.",
});
assert("supplement words not flagged", supplemented.data.length === 0, supplemented.data);

const formerBadWords = await post("/cms-client/modules/spellchecker/check", {
  text: "хүнтай тээвэрээр сургуульн",
});
assert("erroneous forms correctly flagged as misspellings", formerBadWords.data.length === 3, formerBadWords.data);

for (const [typo, fix] of [
  ["хүүнтэй", "хүнтэй"],
  ["тээвэрээр", "тээврээр"],
  ["саайн", "сайн"],
  ["монгл", "монгол"],
]) {
  const got = await post("/cms-client/modules/spellchecker/suggest", { word: typo });
  assert(`suggest(${typo}) offers ${fix} first`, got.data[0] === fix, got.data.slice(0, 3));
}

const english = await post("/cms-client/modules/spellchecker/check", {
  text: "Ths is a tst sentnce with speling mistaks",
});
assert("latin words skipped (parity with original)", english.data.length === 0, english.data);

const dupes = await post("/cms-client/modules/spellchecker/check", {
  text: "монгл монгл Монгл",
});
assert("misspellings deduped case-insensitively", dupes.data.length === 1, dupes.data);

const empty = await post("/cms-client/modules/spellchecker/check", { text: "" });
assert("empty text returns []", empty.status === 200 && empty.data.length === 0, empty.data);

const sug = await post("/cms-client/modules/spellchecker/suggest", { word: "монгл", key: "x" });
assert("suggest includes монгол", sug.data.includes("монгол"), sug.data);
assert("suggest capped at 10", sug.data.length <= 10 && sug.data.length > 0, sug.data);
assert("suggest excludes input word", !sug.data.some((s) => s.toLowerCase() === "монгл"), sug.data);

const sugValid = await post("/cms-client/modules/spellchecker/suggest", { word: "сайн" });
assert("suggest on valid word returns []", sugValid.status === 200 && sugValid.data.length === 0, sugValid.data);

const rep = await post("/cms-client/modules/spellchecker/replace", { source: "аа", target: "бб" });
assert("replace is a no-op 200", rep.status === 200, rep.status);

const pre = await fetch(BASE + "/cms-client/modules/spellchecker/check", { method: "OPTIONS" });
assert("CORS preflight 204", pre.status === 204, pre.status);
assert("CORS origin header", pre.headers.get("access-control-allow-origin") === "*");

const bad = await post("/cms-client/modules/spellchecker/check", { notText: 1 });
assert("missing text is 400", bad.status === 400, bad.status);

const nope = await fetch(BASE + "/cms-client/modules/auth/login");
assert("unknown path is 404", nope.status === 404, nope.status);

const home = await fetch(BASE + "/");
const homeHtml = await home.text();
const homeType = home.headers.get("content-type") || "";
assert("GET / serves the UI", home.status === 200 && homeType.startsWith("text/html"), homeType);
assert("UI references app + styles", homeHtml.includes("/app.js") && homeHtml.includes("/styles.css"));
assert("landing hero rendered", homeHtml.includes("hero__title") && homeHtml.includes("Нээлттэй"));
assert("app embedded in the landing page", homeHtml.includes('id="app"') && homeHtml.includes('id="text"'));
for (const [route, type] of [
  ["/styles.css", "text/css"],
  ["/app.js", "text/javascript"],
  ["/favicon.svg", "image/svg+xml"],
]) {
  const asset = await fetch(BASE + route);
  const assetType = asset.headers.get("content-type") || "";
  assert(`${route} served`, asset.status === 200 && assetType.startsWith(type), assetType);
}
const health = await fetch(BASE + "/healthz");
const healthBody = await health.json();
assert("healthz reports service", health.status === 200 && healthBody.service === "spellcheck-mn-local", healthBody);

const burst = await Promise.all(
  Array.from({ length: 30 }, (_, i) =>
    post("/cms-client/modules/spellchecker/check", { text: `Жишээ өгүүлбэр ${i} монгл дугаартай.` })
  )
);
assert("30 parallel checks all 200 (no rate limit)", burst.every((r) => r.status === 200), burst.map((r) => r.status));
assert("burst results consistent", burst.every((r) => r.data.includes("монгл")));

const t0 = Date.now();
const long = Array.from({ length: 500 }, (_, i) => `Монгол хэлний үгийн санг шалгах жишээ ${i} монгл.`).join(" ");
const big = await post("/cms-client/modules/spellchecker/check", { text: long });
const ms = Date.now() - t0;
assert("large text (500 sentences) checked", big.status === 200 && big.data.includes("монгл"), big.status);
console.log(`  large text: ${long.length} chars in ${ms}ms`);

console.log(`\n${passed} passed, ${failed} failed`);
server.kill("SIGKILL");
process.exit(failed ? 1 : 0);
