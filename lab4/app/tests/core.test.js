import assert from "node:assert/strict";
import { test } from "node:test";

import { CardStreamParser, extractCardObjects, parseJsonLenient, stripFences } from "../web/js/cardParser.js";
import { groundingScore, isDuplicate, normalizeCard, sectionTitle, shortTag, toDeckCard } from "../web/js/cards.js";
import { cardsForChunk, chunkBudgetChars, estimateTokens, planGeneration, splitIntoChunks } from "../web/js/chunker.js";
import { DEFAULT_SETTINGS, validateSettings } from "../web/js/config.js";
import { fromJson, toAnkiTsv, toCsv, toJson } from "../web/js/exporter.js";
import { cardsWord, charsWord, formatSeconds, formatSpeed, formatWhen, plural } from "../web/js/format.js";
import { BOX_DAYS, deckStats, dueQueue, review } from "../web/js/leitner.js";
import { buildGenerationMessages, buildRepairMessages, cyrillicShare } from "../web/js/prompts.js";
import { createStore } from "../web/js/store.js";

const S = DEFAULT_SETTINGS;

test("CardStreamParser віддає картки по мірі надходження символів", () => {
  const json = '{"cards":[{"front":"Що таке L1?","back":"Найшвидший кеш."},{"front":"Що таке L3?","back":"Найбільший кеш."}]}';
  const parser = new CardStreamParser();
  const seen = [];
  let afterFirst = null;
  for (let i = 0; i < json.length; i += 5) {
    seen.push(...parser.push(json.slice(i, i + 5)));
    if (seen.length === 1 && afterFirst === null) afterFirst = i; // перша картка зʼявилась до кінця потоку
  }
  assert.equal(seen.length, 2);
  assert.equal(seen[0].front, "Що таке L1?");
  assert.ok(afterFirst < json.length - 20, "перша картка має зʼявитися раніше за кінець JSON");
});

test("CardStreamParser не плутається в дужках і лапках усередині рядків", () => {
  const json = '{"cards":[{"front":"Що робить }{ у JSON?","back":"Він \\"екранований\\" [ось так]"}]}';
  const found = new CardStreamParser().push(json);
  assert.equal(found.length, 1);
  assert.equal(found[0].back, 'Він "екранований" [ось так]');
});

test("CardStreamParser ігнорує обірваний останній обʼєкт, але лишає завершені", () => {
  const cut = '{"cards":[{"front":"Перше?","back":"Так."},{"front":"Друге?","back":"обір';
  const found = new CardStreamParser().push(cut);
  assert.deepEqual(found.map((c) => c.front), ["Перше?"]);
});

test("CardStreamParser розуміє голий масив і markdown-огорожу", () => {
  const { objects } = extractCardObjects('```json\n[{"front":"A?","back":"B."}]\n```');
  assert.equal(objects.length, 1);
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});

test("extractCardObjects: цілий JSON → complete, обірваний → рятує завершені картки", () => {
  assert.equal(extractCardObjects('{"cards":[{"front":"A?","back":"B"}]}').complete, true);
  const partial = extractCardObjects('{"cards":[{"front":"A?","back":"B"},{"front":"C?","ba');
  assert.equal(partial.complete, false);
  assert.equal(partial.objects.length, 1);
});

test("parseJsonLenient витягує JSON з тексту навколо й повертає null для сміття", () => {
  assert.deepEqual(parseJsonLenient('Ось відповідь: {"verdict":"correct","feedback":"ок"} дякую'), { verdict: "correct", feedback: "ок" });
  assert.equal(parseJsonLenient("зовсім не JSON"), null);
});

test("normalizeCard приймає синоніми полів і відхиляє непридатні картки", () => {
  assert.deepEqual(normalizeCard({ question: " Що таке  кеш? ", answer: "Швидка памʼять." }), { front: "Що таке кеш?", back: "Швидка памʼять." });
  assert.equal(normalizeCard({ front: "", back: "x" }), null);
  assert.equal(normalizeCard({ front: "Питання?", back: "питання?" }), null, "відповідь не може дорівнювати питанню");
  assert.equal(normalizeCard({ front: "x".repeat(300), back: "y" }), null);
  assert.equal(normalizeCard("рядок"), null);
  assert.equal(normalizeCard([1, 2]), null);
});

test("isDuplicate ловить точні й майже однакові питання", () => {
  const deck = [{ front: "Що таке кеш процесора?" }];
  assert.equal(isDuplicate({ front: "що таке кеш процесора" }, deck), true);
  assert.equal(isDuplicate({ front: "Що таке кеш процесора, коротко?" }, deck), true);
  assert.equal(isDuplicate({ front: "Який рівень кешу найшвидший?" }, deck), false);
  assert.equal(isDuplicate({ front: "Що таке кеш L2?" }, [{ front: "Що таке кеш L1?" }]), false);
  assert.equal(isDuplicate({ front: "Що таке кеш L1?" }, [{ front: "Що таке кеш L1?" }]), true);
});

test("isDuplicate: відмінки й помилка в слові не рятують дубль (випадок із повторної генерації)", () => {
  assert.equal(isDuplicate({ front: "Як працює алгорітм Round Robin?" }, [{ front: "Як працює алгоритм Round Robin?" }]), true);
  assert.equal(isDuplicate({ front: "Що таке взаємоблокування?" }, [{ front: "Що таке взаємоблокуванню?" }]), true);
  assert.equal(isDuplicate({ front: "Що повертає LEFT JOIN?" }, [{ front: "Що повертає INNER JOIN?" }]), false);
  assert.equal(isDuplicate({ front: "Що таке семафор?" }, [{ front: "Що таке мʼютекс?" }]), false);
  assert.equal(isDuplicate({ front: "Як TCP встановлює зʼєднання?" }, [{ front: "Як TCP забезпечує доставку даних?" }]), false);
});

test("isDuplicate: перефразоване питання з тією самою відповіддю — дубль (повторна генерація на реальній моделі)", () => {
  const deck = [
    { front: "Який найпростіший практичний спосіб запобігти взаємоблокуванню?", back: "Найпростіший спосіб запобігти взаємоблокуванню — завжди захоплювати ресурси в одному й тому самому порядку." },
    { front: "Чому помилка в потоці може зруйнувати весь процес?", back: "Створити потік дешевше, ніж процес, а обмін даними між потоками швидший, проте помилка в одному потоці може зруйнувати весь процес." },
  ];
  assert.equal(isDuplicate({ front: "Який найпростіший практичний спосіб уникнути взаємоблокування?", back: "Найпростіший спосіб уникнути взаємоблокування — завжди захоплювати ресурси в одному й тому самому порядку." }, deck), true);
  assert.equal(isDuplicate({ front: "Чому створення потоку дешевше, ніж процес? Чи може помилка в потоці зруйнувати процес?", back: deck[1].back }, deck), true);
  assert.equal(isDuplicate({ front: "Що таке семафор?", back: "Семафор — це лічильник, який дозволяє одночасний доступ до ресурсу не більш ніж N потокам." }, deck), false);
  assert.equal(isDuplicate({ front: "Чи є кеш L1 швидшим?", back: "Так" }, [{ front: "Чи має L2 більший обсяг?", back: "Так" }]), false);
  assert.equal(isDuplicate({ front: "Що таке семафор?" }, deck), false);
});

test("sectionTitle обирає розділ, з якого взято відповідь, а не перший заголовок фрагмента", () => {
  const chunk = [
    "## Взаємоблокування", "", "Взаємоблокування — це ситуація, коли кілька потоків чекають один на одного нескінченно.", "",
    "## Файлові системи", "", "Імена зберігаються в каталогах, які зіставляють імʼя з номером inode.",
  ].join("\n");
  assert.equal(sectionTitle(chunk, { back: "Імя файлу зберігається в каталогах, а не в inode." }), "Файлові системи");
  assert.equal(sectionTitle(chunk, { back: "Взаємоблокування — це ситуація, коли потоки чекають нескінченно." }), "Взаємоблокування");
  assert.equal(sectionTitle(chunk, { back: "Квантова хромодинаміка описує сильну взаємодію." }), "Взаємоблокування");
  assert.equal(sectionTitle("Просто текст без заголовків про кеш процесора.", { back: "Кеш процесора швидкий." }), "");
  const withTitle = "# Лекція\n\n## Процеси\n\nПроцес — це програма під час виконання.";
  assert.equal(sectionTitle(withTitle, { back: "Процес — це програма під час виконання." }), "Процеси");
});

test("groundingScore: відповідь із конспекту ≈1, вигадана — низька (з урахуванням відмінків)", () => {
  const source = "Кеш — швидка памʼять між процесором і оперативною памʼяттю. Рівень L1 найменший.";
  assert.ok(groundingScore({ back: "Швидка памʼять між процесором і оперативною памʼяттю." }, source) > 0.9);
  assert.ok(groundingScore({ back: "Кешем називають швидку памʼять процесора." }, source) >= 0.6, "відмінки не мають псувати оцінку");
  assert.ok(groundingScore({ back: "Закон відкрили гноми на Марсі у 1887 році." }, source) < 0.4);
  assert.equal(groundingScore({ back: "L1" }, source), 1, "коротку відповідь перевірити нічим");
});

test("toDeckCard позначає підозрілі картки", () => {
  const src = "Кеш — швидка памʼять між процесором і оперативною памʼяттю.";
  assert.equal(toDeckCard({ front: "Що таке кеш?", back: "Швидка памʼять між процесором і памʼяттю." }, { source: src }).suspect, false);
  assert.equal(toDeckCard({ front: "Хто?", back: "Гноми на Марсі винайшли карнавал." }, { source: src }).suspect, true);
});

test("estimateTokens: кирилиця дорожча за латиницю", () => {
  assert.ok(estimateTokens("привіт світе привіт світе") > estimateTokens("hello world hello wor"));
});

test("chunkBudgetChars у межах [800, 3000] і зменшується разом із контекстом", () => {
  assert.equal(chunkBudgetChars(S), 3000);
  assert.equal(chunkBudgetChars({ ...S, contextTokens: 2048 }), 800 /* нижня межа */);
  const mid = chunkBudgetChars({ ...S, contextTokens: 3000, maxTokens: 600 });
  assert.ok(mid >= 800 && mid <= 3000);
});

test("splitIntoChunks: короткий текст — один фрагмент, порожній — жодного", () => {
  assert.deepEqual(splitIntoChunks("   \n ", 1000), []);
  assert.equal(splitIntoChunks("Один абзац.", 1000).length, 1);
});

test("splitIntoChunks: не перевищує ліміт, не втрачає текст і не розрізає абзаци без потреби", () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `Абзац ${i}. ${"Слово ".repeat(40)}`.trim());
  const chunks = splitIntoChunks(paragraphs.join("\n\n"), 700);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 700 + 60, `фрагмент завеликий: ${c.length}`); // +запас на доданий заголовок
  const joined = chunks.join(" ");
  for (const p of paragraphs) assert.ok(joined.includes(p), "абзац втрачено або розрізано");
});

test("splitIntoChunks: надто довгий абзац ділиться за реченнями, а безперервний рядок — жорстко", () => {
  const long = Array.from({ length: 30 }, (_, i) => `Речення номер ${i} про кеш процесора.`).join(" ");
  const chunks = splitIntoChunks(long, 300);
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.length <= 300));
  const blob = splitIntoChunks("а".repeat(1000), 300);
  assert.equal(blob.length, 4);
});

test("splitIntoChunks: заголовок не лишається в кінці фрагмента й додається до наступних", () => {
  const text = ["# Кеш", "Перший абзац. " + "а".repeat(500), "## Рівні", "Другий абзац. " + "б".repeat(500)].join("\n\n");
  const chunks = splitIntoChunks(text, 600);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    const lines = chunk.trim().split("\n").filter(Boolean);
    assert.ok(!/^#{1,6}\s/.test(lines[lines.length - 1]), `заголовок «висить» наприкінці: ${chunk.slice(-30)}`);
  }
  assert.ok(chunks[1].startsWith("## Рівні"), "новий розділ починає новий фрагмент");
});

test("splitIntoChunks: продовження розділу отримує його заголовок", () => {
  const text = `# Тема\n\n${"Речення про тему. ".repeat(60)}`;
  const chunks = splitIntoChunks(text, 400);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.startsWith("# Тема"), `фрагмент без заголовка: ${chunk.slice(0, 30)}`);
});

test("cardsForChunk і planGeneration рахують розумну кількість карток", () => {
  assert.equal(cardsForChunk("x".repeat(100), S), 2);
  assert.equal(cardsForChunk("x".repeat(5000), S), S.cardsPerChunk);
  const plan = planGeneration("Речення. ".repeat(500), S);
  assert.ok(plan.chunks.length >= 1 && plan.expectedCards >= 2 && plan.inputTokens > 0);
});

test("Leitner: «знав» піднімає коробку й відсуває термін, «не знав» повертає в першу", () => {
  const now = 1_000_000;
  const card = { id: "1", front: "a", back: "b", box: 1, due: 0 };
  const up = review(card, true, now);
  assert.equal(up.box, 2);
  assert.equal(up.due, now + BOX_DAYS[1] * 86_400_000);
  const top = review({ ...card, box: 5 }, true, now);
  assert.equal(top.box, 5, "вище п'ятої коробки не піднімаємось");
  assert.equal(review({ ...card, box: 4 }, false, now).box, 1);
});

test("dueQueue: лише прострочені, спершу нижчі коробки; deckStats рахує коробки", () => {
  const now = 10_000;
  const deck = [
    { id: "a", box: 3, due: 0 }, { id: "b", box: 1, due: 5_000 }, { id: "c", box: 1, due: 20_000 }, { id: "d", box: 2, due: 100 },
  ];
  assert.deepEqual(dueQueue(deck, now).map((c) => c.id), ["b", "d", "a"]);
  const stats = deckStats(deck, now);
  assert.equal(stats.total, 4);
  assert.equal(stats.due, 3);
  assert.deepEqual(stats.boxes, [2, 1, 1, 0, 0]);
});

const DECK = [
  { id: "1", front: "Що таке \"кеш\"?", back: "Швидка памʼять,\nмає рівні", tag: "Кеш процесора", box: 2, due: 0, suspect: false, createdAt: 1 },
  { id: "2", front: "Питання\tз табуляцією?", back: "Відповідь", tag: "", box: 1, due: 0, suspect: true, createdAt: 2 },
];

test("toAnkiTsv: службові рядки, один рядок на картку, без табуляцій і переносів усередині полів", () => {
  const lines = toAnkiTsv(DECK).replace(/\n$/, "").split("\n"); // trimEnd зрізав би порожню колонку тегів
  assert.deepEqual(lines.slice(0, 3), ["#separator:tab", "#html:false", "#tags column:3"]);
  assert.equal(lines.length, 5);
  for (const row of lines.slice(3)) assert.equal(row.split("\t").length, 3);
  assert.ok(lines[3].endsWith("\tКеш_процесора"), "пробіли в тегах замінюються підкресленням");
});

test("toCsv екранує лапки й переноси, має BOM", () => {
  const csv = toCsv(DECK);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"Що таке ""кеш""?"'));
  assert.ok(csv.includes('"Швидка памʼять,\nмає рівні"'));
});

test("toJson ↔ fromJson: круговий обмін зберігає картки; сміття відхиляється зрозумілою помилкою", () => {
  const back = fromJson(toJson(DECK));
  assert.equal(back.length, 2);
  assert.equal(back[0].front, DECK[0].front);
  assert.equal(back[0].box, 2);
  assert.throws(() => fromJson("не json"), /коректним JSON/);
  assert.throws(() => fromJson('{"a":1}'), /немає списку карток/);
  assert.throws(() => fromJson('{"cards":[{"x":1}]}'), /жодної придатної/);
  assert.equal(fromJson('[{"front":"Q?","back":"A","box":99}]')[0].box, 1, "некоректна коробка скидається");
});

test("store: зберігає й відновлює, а зламане/відсутнє сховище не валить застосунок", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const store = createStore(storage);
  assert.deepEqual(store.loadDeck(), []);
  assert.equal(store.saveDeck(DECK), true);
  assert.equal(store.loadDeck().length, 2);
  store.saveSettings({ model: "x" });
  assert.equal(store.loadSettings().model, "x");
  assert.equal(store.loadSettings().maxTokens, S.maxTokens, "відсутні ключі беруться зі значень за замовчуванням");

  const broken = createStore({ getItem: () => "{не json", setItem: () => { throw new Error("quota"); } });
  assert.deepEqual(broken.loadDeck(), []);
  assert.equal(broken.saveDeck(DECK), false);
  assert.equal(createStore(null).saveDeck(DECK), false);
});

test("shortTag скорочує довгий заголовок по межі слова з «…», короткий лишає як є", () => {
  assert.equal(shortTag("Взаємоблокування"), "Взаємоблокування");
  const long = shortTag("Операційні системи: процеси, памʼять і синхронізація");
  assert.ok(long.length <= 40, long);
  assert.ok(long.endsWith("…"), long);
  assert.ok(!/\s…$/.test(long) && !long.includes("і с…"), "не обрізає посеред слова: " + long);
  assert.equal(shortTag(undefined), "");
  assert.equal(shortTag("Х".repeat(60)).length, 40);
});

test("normalizeCard повертає на місце переплутані поля (питання в back), але не чіпає правильні картки", () => {
  const swapped = normalizeCard({ front: "TCP встановлює зʼєднання за допомогою рукостискання.", back: "Як TCP встановлює зʼєднання?" });
  assert.deepEqual(swapped, { front: "Як TCP встановлює зʼєднання?", back: "TCP встановлює зʼєднання за допомогою рукостискання." });
  const fine = { front: "Що таке кеш?", back: "Швидка памʼять." };
  assert.deepEqual(normalizeCard(fine), fine);
  assert.deepEqual(normalizeCard({ front: "Що таке L1?", back: "А що таке L2?" }), { front: "Що таке L1?", back: "А що таке L2?" });
  assert.deepEqual(normalizeCard({ term: "Кеш", definition: "Швидка памʼять." }), { front: "Кеш", back: "Швидка памʼять." });
});

test("промпти: мова й стиль підставляються, приклад є, повтор містить обрізану погану відповідь", () => {
  const uk = buildGenerationMessages({ ...S, language: "uk", style: "qa" }, "ТЕКСТ", 4);
  assert.equal(uk[0].role, "system");
  assert.match(uk[0].content, /Ukrainian/);
  assert.match(uk[3].content, /ТЕКСТ/);
  assert.match(uk[3].content, /Create 4 flashcards/);
  assert.equal(uk[2].role, "assistant");
  assert.ok(JSON.parse(uk[2].content).cards.length === 3, "few-shot відповідь — валідний JSON");
  assert.match(buildGenerationMessages({ ...S, language: "en", style: "term" }, "x", 2)[0].content, /English[\s\S]*|term/);
  const repair = buildRepairMessages(uk, "x".repeat(1000));
  assert.equal(repair.length, uk.length + 2);
  assert.ok(repair[repair.length - 2].content.length < 450);
  assert.match(repair[repair.length - 1].content, /not valid JSON/);
});

test("промпти: у режимі «Як у конспекті» приклад має мову конспекту (знайдено в тесті 4 на реальній моделі)", () => {
  const firstFront = (messages) => JSON.parse(messages[2].content).cards[0].front;
  const english = buildGenerationMessages({ ...S, language: "auto", style: "qa" }, "HTTP is a request-response protocol.", 3);
  assert.match(firstFront(english), /^What is/, "для англійського конспекту приклад англійський");
  assert.match(english[1].content, /Processor cache/, "і приклад конспекту теж англійський");
  assert.match(english[0].content, /both the front and the back/);
  const ukrainian = buildGenerationMessages({ ...S, language: "auto", style: "qa" }, "Квантизація — це зменшення кількості біт.", 3);
  assert.match(firstFront(ukrainian), /^Що таке/);
  assert.match(firstFront(buildGenerationMessages({ ...S, language: "uk" }, "HTTP is a protocol.", 3)), /^Що таке/);
  assert.match(firstFront(buildGenerationMessages({ ...S, language: "en" }, "Квантизація.", 3)), /^What is/);
});

test("cyrillicShare: частка кирилиці серед літер; порожній текст вважається українським", () => {
  assert.equal(cyrillicShare("Привіт"), 1);
  assert.equal(cyrillicShare("Hello"), 0);
  assert.ok(Math.abs(cyrillicShare("Привіт Hellox") - 0.5) < 0.01, "6 кириличних і 6 латинських літер");
  assert.equal(cyrillicShare("123 !?"), 1);
});

test("plural і cardsWord: правильні українські множини", () => {
  const forms = ["картка", "картки", "карток"];
  const expected = { 0: "карток", 1: "картка", 2: "картки", 4: "картки", 5: "карток", 11: "карток", 12: "карток", 14: "карток", 21: "картка", 22: "картки", 100: "карток", 101: "картка", 111: "карток" };
  for (const [n, word] of Object.entries(expected)) assert.equal(plural(Number(n), forms), word, `n=${n}`);
  assert.equal(cardsWord(3), "3 картки");
  assert.deepEqual([1, 3, 5, 21, 935].map(charsWord), ["1 символ", "3 символи", "5 символів", "21 символ", "935 символів"]);
});

test("formatSeconds і formatSpeed: десяткова кома", () => {
  assert.equal(formatSeconds(3.54), "3,5 с");
  assert.equal(formatSeconds(42.4), "42 с");
  assert.equal(formatSpeed(19.74), "19,7 токенів/с");
});

test("formatWhen: хвилини, години, далі — дата", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);
  assert.equal(formatWhen(now - 1000, now), "зараз");
  assert.equal(formatWhen(now + 5 * 60_000, now), "через 5 хв");
  assert.equal(formatWhen(now + 3 * 3_600_000, now), "через 3 год");
  assert.match(formatWhen(now + 3 * 86_400_000, now), /\d/);
});

test("validateSettings: типові значення коректні, недопустимі — з поясненням", () => {
  assert.deepEqual(validateSettings({ ...S }), []);
  assert.ok(validateSettings({ ...S, temperature: 3 }).some((e) => /Temperature/.test(e)));
  assert.ok(validateSettings({ ...S, maxTokens: 50 }).some((e) => /зациклитися/.test(e)));
  assert.ok(validateSettings({ ...S, maxTokens: NaN }).length > 0);
  assert.ok(validateSettings({ ...S, model: "  " }).some((e) => /назву моделі/.test(e)));
  assert.ok(validateSettings({ ...S, baseUrl: "localhost:11434/v1" }).some((e) => /Адреса API/.test(e)));
  assert.deepEqual(validateSettings({ ...S, baseUrl: "http://localhost:11434/v1" }), []);
  assert.ok(validateSettings({ ...S, contextTokens: 2048, maxTokens: 1500 }).some((e) => /не залишають місця/.test(e)));
  assert.ok(validateSettings({ ...S, seed: 1.5 }).some((e) => /Seed/.test(e)));
  assert.deepEqual(validateSettings({ ...S, seed: 42 }), []);
});
