// Інтеграційні тести клієнта й ланцюжка запитів проти mock-сервера (tests/mock_openai_server.py).
// Запуск: node --test (у теці app)   (потрібен Python у PATH: python, py або python3; можна вказати свій у змінній PYTHON)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../web/js/config.js";
import { checkServer, LLMError, listModels, streamChat } from "../web/js/llmClient.js";
import { generateCards, gradeAnswer } from "../web/js/pipeline.js";
import { CARDS_SCHEMA } from "../web/js/prompts.js";

const MOCK = fileURLToPath(new URL("./mock_openai_server.py", import.meta.url));
let child;
let base;

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

const cfg = (model, extra = {}) => ({ ...DEFAULT_SETTINGS, baseUrl: base, model, ...extra });
const requests = async () => (await fetch(`${base.replace("/v1", "")}/_requests`)).json();
const reset = () => fetch(`${base.replace("/v1", "")}/_reset`, { method: "POST", body: "{}" });
const ask = (settings, opts = {}) => streamChat(settings, [{ role: "user", content: 'Notes:\n"""\nКеш — швидка памʼять між процесором і оперативною памʼяттю. Рівень L1 найменший і найшвидший.\n"""\n\nCreate 2 flashcards from these notes.' }], { schema: CARDS_SCHEMA, ...opts });

const NOTES = [
  "# Кеш процесора",
  "Кеш — швидка памʼять між процесором і оперативною памʼяттю. Рівні L1, L2 і L3 відрізняються розміром і швидкістю.",
  "Рівень L1 найменший і найшвидший, а рівень L3 найбільший і найповільніший серед усіх рівнів кешу.",
  "Коли потрібних даних у кеші немає, відбувається кеш-промах, і дані читаються з повільнішої оперативної памʼяті.",
].join("\n\n");

// У Windows команди python3 зазвичай немає (є python або py), у Linux/macOS — навпаки, тож пробуємо кілька.
const PYTHONS = process.env.PYTHON ? [process.env.PYTHON] : process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];

async function startMock(command, port) {
  let spawnFailed = false;
  const proc = spawn(command, [MOCK, "--port", String(port)], { stdio: "ignore" });
  proc.on("error", () => { spawnFailed = true; }); // немає такої команди — без падіння всього тесту
  for (let i = 0; i < 50 && !spawnFailed; i++) {
    try {
      if ((await fetch(`${base}/models`)).ok) return proc;
    } catch { /* сервер ще стартує */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  return null;
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}/v1`;
  for (const command of PYTHONS) {
    child = await startMock(command, port);
    if (child) return;
  }
  throw new Error(`mock-сервер не запустився; спробовано: ${PYTHONS.join(", ")}. Потрібен Python у PATH (або змінна PYTHON зі шляхом до python.exe).`);
});

after(() => child?.kill());

async function failsWith(promise, kind) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LLMError, `очікувався LLMError, а отримано ${error}`);
    assert.equal(error.kind, kind, error.message);
    return true;
  });
}

// ---------- streamChat ----------
test("streamChat: стрімить фрагменти, збирає текст і метрики, надсилає правильні параметри", async () => {
  await reset();
  const pieces = [];
  const r = await ask(cfg("mock-ok", { seed: 7 }), { onDelta: (p) => pieces.push(p) });
  assert.ok(pieces.length > 3, "відповідь має приходити частинами");
  assert.equal(pieces.join(""), r.text);
  assert.equal(r.finishReason, "stop");
  assert.ok(r.tokens > 0 && r.ttft >= 0 && r.latency >= r.ttft);
  assert.equal(JSON.parse(r.text).cards.length, 2);

  const [sent] = await requests();
  assert.equal(sent.stream, true);
  assert.equal(sent.max_tokens, 1200, "ліміт токенів обовʼязковий");
  assert.equal(sent.temperature, 0.3);
  assert.equal(sent.top_p, 0.9);
  assert.equal(sent.seed, 7);
  assert.equal(sent.reasoning_effort, "none");
  assert.equal(sent.response_format.type, "json_schema");
  assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual(sent.stream_options, { include_usage: true });
});

test("streamChat: без seed і зі «стандартним» міркуванням зайвих полів немає", async () => {
  await reset();
  await ask(cfg("mock-ok", { reasoning: "default", structured: "off" }));
  const [sent] = await requests();
  assert.ok(!("seed" in sent) && !("reasoning_effort" in sent) && !("response_format" in sent));
});

test("streamChat: сервер без підтримки response_format → двоступеневий відкат і успіх", async () => {
  await reset();
  const r = await ask(cfg("mock-nostruct"));
  assert.equal(r.fallbacks.length, 2);
  assert.match(r.fallbacks[0], /json_schema/);
  assert.equal(JSON.parse(r.text).cards.length, 2);
  const sent = await requests();
  assert.equal(sent.length, 3);
  assert.ok(!("response_format" in sent[2]));
});

test("streamChat: reasoning_effort ігнорується/вимикається; міркування помічається", async () => {
  const quiet = await ask(cfg("mock-reasoning"));
  assert.equal(quiet.reasoningSeen, false);
  const thoughts = [];
  const loud = await ask(cfg("mock-reasoning", { reasoning: "default" }), { onReasoning: (t) => thoughts.push(t) });
  assert.equal(loud.reasoningSeen, true);
  assert.ok(thoughts.length === 3);
  assert.equal(JSON.parse(loud.text).cards.length, 2);
});

test("streamChat: непридатні сценарії дають зрозумілі типи помилок", async () => {
  await failsWith(ask(cfg("no-such-model")), "model_not_found");
  await failsWith(ask(cfg("mock-500")), "server");
  await failsWith(ask({ ...cfg("mock-ok"), baseUrl: "http://127.0.0.1:1/v1" }), "unreachable");
  await failsWith(ask(cfg("mock-midcut")), "connection_lost");
});

test("streamChat: повідомлення про відсутню модель підказує, що робити", async () => {
  try {
    await ask(cfg("qwen3:9b"));
    assert.fail("мало кинути помилку");
  } catch (error) {
    assert.match(error.message, /qwen3:9b/);
    assert.match(error.message, /ollama pull/);
  }
});

test("streamChat: таймаут першого токена й ручна зупинка", async () => {
  const t0 = performance.now();
  await failsWith(ask(cfg("mock-silent", { firstTokenTimeoutS: 0.3 })), "timeout");
  assert.ok(performance.now() - t0 < 3000, "таймаут має спрацювати швидко");

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 250);
  await failsWith(ask(cfg("mock-slow"), { signal: controller.signal }), "aborted");

  const already = new AbortController();
  already.abort();
  await failsWith(ask(cfg("mock-ok"), { signal: already.signal }), "aborted");
});

test("streamChat: HTML-відповідь замість API підказує запустити serve.py", async () => {
  // mock віддає JSON 404 на невідомий шлях, тож імітуємо «чужий» сервер власним fetch
  const html = async () => new Response("<html>Error 501</html>", { status: 501, headers: { "Content-Type": "text/html" } });
  await assert.rejects(ask(cfg("mock-ok"), { fetchImpl: html }), (e) => e.kind === "wrong_server" && /serve\.py/.test(e.message));
});

test("listModels і checkServer: ready / model_missing / unreachable", async () => {
  assert.ok((await listModels(cfg("mock-ok"))).includes("mock-ok"));
  assert.equal((await checkServer(cfg("mock-ok"))).state, "ready");
  const missing = await checkServer(cfg("qwen3:1.7b"));
  assert.equal(missing.state, "model_missing");
  assert.match(missing.message, /qwen3:1\.7b/);
  assert.equal((await checkServer({ ...cfg("mock-ok"), baseUrl: "http://127.0.0.1:1/v1" })).state, "unreachable");
});

// ---------- pipeline ----------
test("generateCards: картки зʼявляються по одній ще до завершення відповіді", async () => {
  const events = [];
  const t0 = performance.now();
  const r = await generateCards({
    settings: cfg("mock-slow"), notes: NOTES,
    onCard: (c) => events.push({ at: performance.now() - t0, front: c.front }),
    onProgress: (e) => events.push({ stage: e.stage }),
  });
  assert.equal(r.fatal, null);
  assert.ok(r.cards.length >= 2, `карток: ${r.cards.length}`);
  assert.ok(r.cards.every((c) => !c.suspect), "картки зі змісту конспекту не мають бути підозрілими");
  assert.equal(events.filter((e) => e.stage === "done").length, 1);
  const cardTimes = events.filter((e) => e.front).map((e) => e.at);
  assert.ok(cardTimes[cardTimes.length - 1] - cardTimes[0] > 100, "картки мають зʼявлятися з інтервалами, а не всі одразу");
  assert.equal(r.problems.length, 0);
  assert.ok(r.stats.tokens > 0);
});

test("generateCards: поганий JSON → повторний запит виправляє", async () => {
  const r = await generateCards({ settings: cfg("mock-badjson"), notes: NOTES });
  assert.ok(r.cards.length >= 2);
  assert.ok(r.problems.some((p) => p.kind === "repaired"));
});

test("generateCards: модель завжди вʼяло відповідає сміттям → проблема bad_output, але без падіння", async () => {
  const r = await generateCards({ settings: cfg("mock-garbage"), notes: NOTES });
  assert.equal(r.cards.length, 0);
  assert.equal(r.fatal, null);
  const problem = r.problems.find((p) => p.kind === "bad_output");
  assert.ok(problem);
  assert.match(problem.message, /початок відповіді/);
});

test("generateCards: обрізана відповідь — зберігає, що встигло, і попереджає про ліміт", async () => {
  const r = await generateCards({ settings: cfg("mock-truncate", { cardsPerChunk: 6 }), notes: NOTES });
  assert.ok(r.problems.some((p) => p.kind === "truncated"));
  assert.match(r.problems.find((p) => p.kind === "truncated").message, /ліміт/);
});

test("generateCards: обрізана відповідь, де розібрані картки — дублі, не прикидається «усі картки вже є»", async () => {
  const first = await generateCards({ settings: cfg("mock-truncate", { cardsPerChunk: 6 }), notes: NOTES });
  assert.ok(first.cards.length >= 1, "перший прогін щось зберіг");
  const again = await generateCards({ settings: cfg("mock-truncate", { cardsPerChunk: 6 }), notes: NOTES, existing: first.cards });
  const truncated = again.problems.find((p) => p.kind === "truncated");
  assert.ok(truncated, "обрізання все одно повідомляється");
  assert.match(truncated.message, /вже є в колоді/);
  assert.ok(!again.problems.some((p) => p.kind === "duplicates"), "окреме «усі картки вже є» дублювало б і плутало повідомлення");
});

test("generateCards: вигадані моделлю картки позначаються підозрілими", async () => {
  const r = await generateCards({ settings: cfg("mock-hallucinate"), notes: NOTES });
  assert.ok(r.cards.length >= 1);
  assert.ok(r.cards.every((c) => c.suspect), "відповідь про гномів на Марсі не спирається на конспект");
});

test("generateCards: недоступний сервер → fatal unreachable, картки не губляться", async () => {
  const r = await generateCards({ settings: { ...cfg("mock-ok"), baseUrl: "http://127.0.0.1:1/v1" }, notes: NOTES });
  assert.equal(r.fatal?.kind, "unreachable");
  assert.equal(r.cards.length, 0);
});

test("generateCards: повторна генерація з того самого конспекту не дублює колоду", async () => {
  const first = await generateCards({ settings: cfg("mock-ok"), notes: NOTES });
  const again = await generateCards({ settings: cfg("mock-ok"), notes: NOTES, existing: first.cards });
  assert.equal(again.cards.length, 0);
  assert.ok(again.problems.some((p) => p.kind === "duplicates"));
  assert.ok(!again.problems.some((p) => p.kind === "bad_output"), "дублікати — не «погана відповідь»");
});

test("generateCards: довгий конспект ділиться на кілька запитів, прогрес рахується", async () => {
  const long = Array.from({ length: 24 }, (_, i) => `Факт номер ${i} стверджує, що компонент ${i} архітектури процесора працює з частотою ${i * 100} мегагерц у режимі ${i}.`).join("\n\n");
  await reset();
  const progress = [];
  const r = await generateCards({
    settings: cfg("mock-ok", { contextTokens: 2048, maxTokens: 400 }), // малий контекст → малі фрагменти
    notes: long, onProgress: (e) => e.stage === "chunk" && progress.push(e),
  });
  assert.ok(progress.length >= 2, `фрагментів: ${progress.length}`);
  assert.deepEqual(progress.map((p) => p.index), progress.map((_, i) => i));
  assert.equal((await requests()).length, progress.length);
  assert.ok(r.cards.length > progress.length);
});

test("generateCards: зупинка користувачем повертає fatal aborted і вже створені картки", async () => {
  const controller = new AbortController();
  const long = Array.from({ length: 6 }, () => NOTES).join("\n\n");
  let first = true;
  const r = await generateCards({
    settings: cfg("mock-slow", { contextTokens: 2048, maxTokens: 400 }), notes: long, signal: controller.signal,
    onCard: () => { if (first) { first = false; controller.abort(); } },
  });
  assert.equal(r.fatal?.kind, "aborted");
  assert.ok(r.cards.length >= 1, "картки, створені до зупинки, зберігаються");
});

test("gradeAnswer: розбирає вердикт; сміття від моделі → зрозуміла помилка", async () => {
  const g = await gradeAnswer({ settings: cfg("mock-ok"), card: { front: "Що таке кеш?", back: "Швидка памʼять." }, answer: "Якась памʼять" });
  assert.equal(g.verdict, "partial");
  assert.ok(g.feedback.length > 5);
  const junk = async () => ({ text: "не знаю" });
  await assert.rejects(gradeAnswer({ settings: cfg("mock-ok"), card: { front: "q", back: "a" }, answer: "x", llm: junk }), (e) => e.kind === "bad_output");
});
