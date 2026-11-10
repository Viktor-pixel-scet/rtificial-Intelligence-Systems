// Точка входу: звʼязує модулі з DOM. Уся логіка, яку можна перевірити без браузера, лежить в інших модулях;
// тут — лише відображення й обробка подій. Текст від моделі завжди вставляється через textContent (без innerHTML).

import { estimateTokens, planGeneration } from "./chunker.js";
import { DEFAULT_SETTINGS, PARAM_NOTES, validateSettings } from "./config.js";
import { fromJson, toAnkiTsv, toCsv, toJson } from "./exporter.js";
import { cardsWord, charsWord, chunksWord, formatSeconds, formatSpeed, formatWhen } from "./format.js";
import { isDuplicate } from "./cards.js";
import { deckStats, dueQueue, review } from "./leitner.js";
import { checkServer } from "./llmClient.js";
import { generateCards, gradeAnswer } from "./pipeline.js";
import { SAMPLE_NOTES } from "./sample.js";
import { createStore } from "./store.js";

const $ = (id) => document.getElementById(id);
const store = createStore();

let settings = store.loadSettings();
let deck = store.loadDeck();
let abortController = null; // поточна генерація
const study = { queue: [], revealed: false, grading: false };

// ---------- допоміжне ----------
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function addNotice(kind, text, container = $("notices")) {
  const node = make("p", `notice ${kind}`, text);
  container.append(node);
  return node;
}

function persistDeck() {
  if (!store.saveDeck(deck)) {
    if (!$("deckStorageWarned")) {
      const node = addNotice("warn", "Браузер не дозволяє зберігати колоду між сесіями. Експортуйте її, перш ніж закрити вкладку.", $("notices"));
      node.id = "deckStorageWarned";
    }
  }
}

function cardElement(card, { onDelete } = {}) {
  const item = make("li", "index-card");
  const head = make("div", "card-head");
  head.append(make("span", "tag", card.tag || "\u00a0"));
  if (card.suspect) {
    const badge = make("span", "badge", "Перевірте за конспектом");
    badge.title = "Відповідь майже не збігається з текстом конспекту — модель могла її вигадати.";
    head.append(badge);
  }
  item.append(head, make("p", "front", card.front), make("p", "back", card.back));
  if (onDelete) {
    const foot = make("div", "card-foot");
    foot.append(make("span", "", `Коробка ${card.box} з 5`));
    const button = make("button", "small danger", "Видалити");
    button.type = "button";
    button.setAttribute("aria-label", `Видалити картку: ${card.front}`);
    button.addEventListener("click", () => onDelete(card));
    foot.append(button);
    item.append(foot);
  }
  return item;
}

// ---------- стан звʼязку з моделлю ----------
async function refreshStatus() {
  const status = $("status");
  status.dataset.state = "checking";
  $("statusText").textContent = "Перевіряю звʼязок із моделлю…";
  const result = await checkServer(settings);
  const datalist = $("modelList");
  datalist.replaceChildren(...result.models.map((name) => Object.assign(document.createElement("option"), { value: name })));
  status.dataset.state = result.state;
  const text = {
    ready: `Модель ${settings.model} готова`,
    model_missing: `Моделі ${settings.model} немає на сервері`,
    unreachable: "Немає звʼязку із сервером моделі",
    error: "Сервер моделі повернув помилку",
  }[result.state];
  $("statusText").textContent = text;
  status.title = result.state === "model_missing"
    ? `Завантажте модель (наприклад, «ollama pull ${settings.model}») або виберіть іншу в налаштуваннях. Доступні: ${result.models.join(", ") || "—"}`
    : result.message ?? "";
}

// ---------- вкладки ----------
const VIEWS = ["create", "study", "deck"];

function showView(name) {
  for (const view of VIEWS) {
    $(`view-${view}`).hidden = view !== name;
    const tab = $(`tab-${view}`);
    tab.setAttribute("aria-selected", String(view === name));
    tab.tabIndex = view === name ? 0 : -1;
  }
  if (name === "study") openStudy();
  if (name === "deck") renderDeck();
}

function currentView() {
  return VIEWS.find((view) => !$(`view-${view}`).hidden);
}

document.querySelectorAll(".tabs [role=tab]").forEach((tab) => {
  tab.addEventListener("click", () => showView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    const next = VIEWS[(VIEWS.indexOf(tab.dataset.view) + step + VIEWS.length) % VIEWS.length];
    showView(next);
    $(`tab-${next}`).focus();
  });
});

function renderCounts() {
  const stats = deckStats(deck);
  $("deckCount").textContent = stats.total ? String(stats.total) : "";
  $("dueCount").textContent = stats.due ? String(stats.due) : "";
}

// ---------- створення карток ----------
function updatePlan() {
  const text = $("notes").value;
  $("counter").textContent = text.trim() ? `${charsWord(text.length)}, ≈${estimateTokens(text)} токенів` : "";
  if (!text.trim()) {
    $("plan").textContent = "";
    return;
  }
  const plan = planGeneration(text, readOptions());
  $("plan").textContent = `${chunksWord(plan.chunks.length)} по ≤${plan.maxChars} символів, приблизно ${cardsWord(plan.expectedCards)}. ` +
    `Ліміт відповіді — ${settings.maxTokens} токенів, контекст — ${settings.contextTokens}.`;
}

function readOptions() {
  return { ...settings, style: $("style").value, language: $("language").value, cardsPerChunk: clampInt($("cardsPerChunk").value, 2, 12, settings.cardsPerChunk) };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function setBusy(busy) {
  $("generate").disabled = busy;
  $("stop").hidden = !busy;
  $("notes").readOnly = busy;
}

function setProgress(fraction, text) {
  $("progress").hidden = false;
  $("barFill").style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  $("progressText").textContent = text;
}

async function onGenerate() {
  $("notices").replaceChildren();
  const notes = $("notes").value.trim();
  if (notes.length < 40) {
    addNotice("warn", "Конспект замалий: вставте хоча б кілька речень, інакше моделі нема з чого робити картки.");
    $("raw").textContent = ""; // відповідь попереднього запуску не має стояти під повідомленням про відмову
    $("rawBox").hidden = true;
    return;
  }
  settings = readOptions();
  store.saveSettings(settings);

  abortController = new AbortController();
  setBusy(true);
  $("fresh").replaceChildren();
  $("emptyHint").hidden = true;
  $("rawBox").hidden = false;
  $("raw").textContent = "";
  let raw = "";
  let added = 0;
  let chunk = { index: 0, total: 1, asked: 1, got: 0 };
  setProgress(0, "Надсилаю запит моделі… Перший запит може тривати довше: модель завантажується в памʼять.");

  try {
    const result = await generateCards({
      settings, notes, existing: deck, signal: abortController.signal,
      onProgress: (event) => {
        if (event.stage !== "chunk") return;
        chunk = { index: event.index, total: event.total, asked: event.cardsAsked, got: 0 };
        setProgress(event.index / event.total, `Фрагмент ${event.index + 1} з ${event.total}: модель пише картки…`);
      },
      onCard: (card) => {
        deck.push(card);
        persistDeck();
        added++;
        chunk.got++;
        $("fresh").append(cardElement(card));
        renderCounts();
        setProgress((chunk.index + Math.min(0.95, chunk.got / chunk.asked)) / chunk.total,
          `Фрагмент ${chunk.index + 1} з ${chunk.total}: створено ${cardsWord(added)}`);
      },
      onRaw: (piece) => {
        raw = (raw + piece).slice(-20000);
        $("raw").textContent = raw;
        $("raw").scrollTop = $("raw").scrollHeight;
      },
    });
    reportResult(result, added);
  } catch (error) {
    // сюди потрапляють лише справді непередбачені помилки (баги), усе очікуване обробляє pipeline
    console.error(error);
    addNotice("error", `Непередбачена помилка: ${error.message}. Відкрийте консоль браузера (F12) — там докладніше.`);
  } finally {
    abortController = null;
    setBusy(false);
    $("progress").hidden = true;
    if (!$("fresh").children.length) $("emptyHint").hidden = false;
    $("rawBox").hidden = !raw; // порожній блок «Сирий вихід» після збою нічого не дає
  }
}

function reportResult({ problems, stats, fatal }, added) {
  if (fatal) {
    addNotice(fatal.kind === "aborted" ? "warn" : "error", fatal.message);
    if (added) addNotice("ok", `Уже створені картки (${added}) збережено в колоді.`);
    if (["unreachable", "connection_lost", "model_not_found"].includes(fatal.kind)) refreshStatus();
  } else {
    const speed = stats.tokensPerS ? `, ≈${formatSpeed(stats.tokensPerS)}` : "";
    addNotice(added ? "ok" : "warn",
      added ? `Готово: ${cardsWord(added)} за ${formatSeconds(stats.seconds)}${speed}.` : "Модель не створила нових карток.");
  }
  for (const problem of problems) addNotice(problem.kind === "repaired" ? "ok" : "warn", problem.message);
  for (const note of stats.fallbacks) addNotice("warn", `Сумісність із сервером: ${note}.`);
  const suspects = [...$("fresh").querySelectorAll(".badge")].length;
  if (suspects) {
    addNotice("warn", `${cardsWord(suspects)} позначено «Перевірте за конспектом»: їхні відповіді майже не збігаються з текстом конспекту.`);
  }
  renderCounts();
}

// ---------- повторення ----------
function currentStudyCard() {
  return deck.find((card) => card.id === study.queue[0]);
}

function openStudy() {
  study.queue = dueQueue(deck).map((card) => card.id);
  study.revealed = false;
  renderStudy();
}

function renderStudy() {
  const card = currentStudyCard();
  const box = $("studyBox");
  const empty = $("studyEmpty");
  box.hidden = !card;
  empty.hidden = Boolean(card);
  if (!card) {
    if (!deck.length) {
      empty.textContent = "У колоді немає карток. Створіть їх на вкладці «Створення».";
    } else {
      const upcoming = deck.map((c) => c.due).filter((due) => due > Date.now()).sort((a, b) => a - b)[0];
      empty.textContent = `На сьогодні все повторено.${upcoming ? ` Наступна картка — ${formatWhen(upcoming)}.` : ""}`;
    }
    return;
  }
  $("studyProgress").textContent = `У черзі: ${cardsWord(study.queue.length)}. Коробка картки: ${card.box} з 5.`;
  $("studyTag").textContent = card.tag || "\u00a0";
  $("studySuspect").hidden = !card.suspect;
  $("studyFront").textContent = card.front;
  $("studyBack").textContent = card.back;
  $("studyBack").hidden = !study.revealed;
  $("reveal").hidden = study.revealed;
  $("dontKnow").hidden = !study.revealed;
  $("know").hidden = !study.revealed;
  $("answerBox").hidden = study.revealed && !$("gradeResult").dataset.verdict;
  if (!study.revealed) {
    $("myAnswer").value = "";
    $("gradeResult").hidden = true;
    delete $("gradeResult").dataset.verdict;
  }
  $("gradeBusy").hidden = !study.grading;
  $("checkAnswer").disabled = study.grading;
}

function reveal() {
  if (!currentStudyCard() || study.revealed) return;
  study.revealed = true;
  renderStudy();
}

function answerCard(knew) {
  const card = currentStudyCard();
  if (!card || !study.revealed) return;
  const index = deck.findIndex((c) => c.id === card.id);
  deck[index] = review(card, knew);
  persistDeck();
  study.queue.shift();
  if (!knew) study.queue.push(card.id); // не знав — повторимо ще раз у цій сесії
  study.revealed = false;
  renderCounts();
  renderStudy();
}

async function onCheckAnswer() {
  const card = currentStudyCard();
  const answer = $("myAnswer").value.trim();
  const result = $("gradeResult");
  if (!card || study.grading) return;
  if (!answer) {
    result.hidden = false;
    result.dataset.verdict = "";
    result.textContent = "Спершу напишіть свою відповідь.";
    return;
  }
  study.grading = true;
  renderStudy();
  try {
    const grade = await gradeAnswer({ settings, card, answer });
    const label = { correct: "Правильно", partial: "Частково", wrong: "Невірно" }[grade.verdict];
    result.dataset.verdict = grade.verdict;
    result.textContent = `${label}. ${grade.feedback}`;
  } catch (error) {
    result.dataset.verdict = "error";
    result.textContent = error.message ?? "Не вдалося оцінити відповідь.";
  } finally {
    study.grading = false;
    result.hidden = false;
    study.revealed = true; // після оцінки показуємо еталон
    renderStudy();
    $("answerBox").hidden = false;
  }
}

document.addEventListener("keydown", (event) => {
  if (currentView() !== "study" || event.target.closest("input, textarea, select, button, dialog")) return;
  if (event.key === " " || event.key === "Enter") {
    event.preventDefault();
    reveal();
  } else if (event.key === "1") {
    answerCard(false);
  } else if (event.key === "2") {
    answerCard(true);
  }
});

// ---------- колода та експорт ----------
function renderDeck() {
  const stats = deckStats(deck);
  $("deckList").replaceChildren(...deck.map((card) => cardElement(card, { onDelete: deleteCard })));
  $("deckEmpty").hidden = deck.length > 0;
  $("deckStats").textContent = deck.length
    ? `${cardsWord(stats.total)}, до повторення зараз — ${stats.due}. За коробками: ${stats.boxes.join(" / ")}.`
    : "";
  for (const id of ["exportAnki", "exportCsv", "exportJson", "clearDeck"]) $(id).disabled = !deck.length;
}

function deleteCard(card) {
  deck = deck.filter((c) => c.id !== card.id);
  persistDeck();
  renderCounts();
  renderDeck();
}

function download(filename, mime, content) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function onImport(event) {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  $("deckNotices").replaceChildren();
  try {
    const incoming = fromJson(await file.text());
    const fresh = [];
    for (const card of incoming) {
      if (deck.some((c) => c.id === card.id) || isDuplicate(card, [...deck, ...fresh])) continue;
      fresh.push(card);
    }
    deck.push(...fresh);
    persistDeck();
    renderCounts();
    renderDeck();
    addNotice("ok", `Імпортовано ${cardsWord(fresh.length)}; пропущено дублікатів: ${incoming.length - fresh.length}.`, $("deckNotices"));
  } catch (error) {
    addNotice("error", `Не вдалося імпортувати файл: ${error.message}.`, $("deckNotices"));
  }
}

// ---------- налаштування ----------
const NUMERIC = ["temperature", "topP", "maxTokens", "contextTokens", "firstTokenTimeoutS", "idleTimeoutS"];
const TEXT = ["baseUrl", "model", "apiKey", "reasoning", "structured"];

function fillSettingsForm(values) {
  for (const key of [...NUMERIC, ...TEXT]) $(`s-${key}`).value = values[key];
  $("s-seed").value = values.seed ?? "";
}

function readSettingsForm() {
  const candidate = { ...settings };
  for (const key of TEXT) candidate[key] = $(`s-${key}`).value.trim();
  for (const key of NUMERIC) candidate[key] = $(`s-${key}`).value === "" ? NaN : Number($(`s-${key}`).value);
  const seed = $("s-seed").value.trim();
  candidate.seed = seed === "" ? null : Number(seed);
  return candidate;
}

function openSettings() {
  fillSettingsForm(settings);
  $("settingsError").hidden = true;
  $("settingsDialog").showModal();
}

function onSaveSettings(event) {
  event.preventDefault();
  const candidate = readSettingsForm();
  const errors = validateSettings(candidate);
  if (errors.length) {
    $("settingsError").hidden = false;
    $("settingsError").textContent = errors.join(" ");
    return;
  }
  settings = candidate;
  store.saveSettings(settings);
  $("settingsDialog").close();
  updatePlan();
  refreshStatus();
}

// ---------- ініціалізація ----------
function init() {
  for (const element of document.querySelectorAll("[data-note]")) element.textContent = PARAM_NOTES[element.dataset.note] ?? "";
  $("style").value = settings.style;
  $("language").value = settings.language;
  $("cardsPerChunk").value = settings.cardsPerChunk;
  $("notes").value = store.loadDraft();

  $("notes").addEventListener("input", () => {
    store.saveDraft($("notes").value);
    updatePlan();
  });
  for (const id of ["style", "language", "cardsPerChunk"]) $(id).addEventListener("change", updatePlan);
  $("sample").addEventListener("click", () => {
    $("notes").value = SAMPLE_NOTES;
    store.saveDraft(SAMPLE_NOTES);
    updatePlan();
  });
  $("file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    $("notices").replaceChildren();
    if (file.size > 500_000) {
      addNotice("error", "Файл завеликий (понад 500 КБ). Розбийте конспект на частини й завантажуйте по одній.");
      return;
    }
    const text = await file.text();
    if (text.includes("\u0000")) {
      addNotice("error", "Це схоже на бінарний файл. Підтримуються лише текстові файли .txt і .md.");
      return;
    }
    $("notes").value = text;
    store.saveDraft(text);
    updatePlan();
  });
  for (const [labelId, inputId] of [["fileLabel", "file"], ["importLabel", "importJson"]]) {
    $(labelId).addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        $(inputId).click();
      }
    });
  }

  $("generate").addEventListener("click", onGenerate);
  $("stop").addEventListener("click", () => abortController?.abort());

  $("reveal").addEventListener("click", reveal);
  $("know").addEventListener("click", () => answerCard(true));
  $("dontKnow").addEventListener("click", () => answerCard(false));
  $("checkAnswer").addEventListener("click", onCheckAnswer);

  $("exportAnki").addEventListener("click", () => download("kartky-anki.txt", "text/tab-separated-values", toAnkiTsv(deck)));
  $("exportCsv").addEventListener("click", () => download("kartky.csv", "text/csv", toCsv(deck)));
  $("exportJson").addEventListener("click", () => download("kartky.json", "application/json", toJson(deck)));
  $("importJson").addEventListener("change", onImport);
  $("clearDeck").addEventListener("click", () => {
    if (!deck.length || !confirm(`Видалити всі картки (${deck.length})? Цю дію не можна скасувати.`)) return;
    deck = [];
    persistDeck();
    renderCounts();
    renderDeck();
  });

  $("openSettings").addEventListener("click", openSettings);
  $("settingsForm").addEventListener("submit", onSaveSettings);
  $("cancelSettings").addEventListener("click", () => $("settingsDialog").close());
  $("resetSettings").addEventListener("click", () => fillSettingsForm(DEFAULT_SETTINGS));

  window.addEventListener("online", refreshStatus);
  renderCounts();
  updatePlan();
  refreshStatus();
}

init();
