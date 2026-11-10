// Ланцюжок запитів до моделі:
//   конспект → фрагменти → [запит на картки → потоковий розбір → перевірка → (повторний запит у разі збою)] × N
//   і окремо — оцінювання відповіді студента.
// Модуль не торкається DOM: усе, що бачить користувач, іде через колбеки, тому його легко тестувати.

import { CardStreamParser, extractCardObjects, parseJsonLenient } from "./cardParser.js";
import { isDuplicate, normalizeCard, sectionTitle, shortTag, toDeckCard } from "./cards.js";
import { cardsForChunk, chunkBudgetChars, splitIntoChunks } from "./chunker.js";
import { LLMError, streamChat } from "./llmClient.js";
import { buildGenerationMessages, buildGradeMessages, buildRepairMessages, CARDS_SCHEMA, GRADE_SCHEMA } from "./prompts.js";

// Ці збої не мають сенсу повторювати на наступних фрагментах — зупиняємо весь ланцюжок.
const FATAL_KINDS = new Set(["unreachable", "connection_lost", "timeout", "model_not_found", "wrong_server", "auth", "server", "aborted"]);

/**
 * Створює картки з конспекту.
 * @param {object} args
 * @param {object} args.settings
 * @param {string} args.notes
 * @param {Array} args.existing — уже наявні картки (для дедуплікації)
 * @param {AbortSignal} [args.signal]
 * @param {(e: object) => void} [args.onProgress] — {stage, index, total, chunkChars, cardsAsked}
 * @param {(card: object) => void} [args.onCard] — нова картка пройшла перевірку
 * @param {(piece: string) => void} [args.onRaw] — сирий текст від моделі
 * @param {Function} [args.llm] — підміна streamChat у тестах
 * @returns {Promise<{cards, problems, stats, fatal}>}
 */
export async function generateCards({ settings, notes, existing = [], signal, onProgress = () => {}, onCard = () => {}, onRaw = () => {}, llm = streamChat }) {
  const chunks = splitIntoChunks(notes, chunkBudgetChars(settings));
  const cards = [];
  const problems = [];
  const stats = { chunks: chunks.length, tokens: 0, seconds: 0, speeds: [], fallbacks: [] };
  const started = performance.now();
  let fatal = null;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const count = cardsForChunk(chunk, settings);
    onProgress({ stage: "chunk", index, total: chunks.length, chunkChars: chunk.length, cardsAsked: count });
    try {
      await runChunk({ settings, chunk, count, index, signal, llm, onRaw, stats, problems, known: [...existing, ...cards], onCard: (card) => {
        cards.push(card);
        onCard(card);
      } });
    } catch (error) {
      if (!(error instanceof LLMError)) throw error;
      if (FATAL_KINDS.has(error.kind)) {
        fatal = error;
        break;
      }
      problems.push({ chunk: index + 1, kind: error.kind, message: error.message });
    }
  }

  stats.seconds = (performance.now() - started) / 1000;
  stats.tokensPerS = stats.speeds.length ? stats.speeds.reduce((a, b) => a + b, 0) / stats.speeds.length : null;
  onProgress({ stage: "done", total: chunks.length });
  return { cards, problems, stats, fatal };
}

async function runChunk({ settings, chunk, count, index, signal, llm, onRaw, onCard, stats, problems, known }) {
  const messages = buildGenerationMessages(settings, chunk, count);
  const accepted = [];
  let seen = 0; // скільки придатних карток розібрано (разом з дублікатами)

  const accept = (raw) => {
    const card = normalizeCard(raw);
    if (!card) return false;
    seen++;
    if (isDuplicate(card, [...known, ...accepted])) return false;
    const deckCard = toDeckCard(card, { source: chunk, tag: shortTag(sectionTitle(chunk, card)) });
    accepted.push(deckCard);
    onCard(deckCard);
    return true;
  };

  const attempt = async (msgs, temperature) => {
    const parser = new CardStreamParser();
    const result = await llm(settings, msgs, {
      signal, schema: CARDS_SCHEMA, schemaName: "cards", temperature,
      onDelta: (piece) => {
        onRaw(piece);
        for (const obj of parser.push(piece)) accept(obj);
      },
    });
    stats.tokens += result.tokens ?? 0;
    if (result.tokensPerS) stats.speeds.push(result.tokensPerS);
    for (const note of result.fallbacks ?? []) if (!stats.fallbacks.includes(note)) stats.fallbacks.push(note);
    return result;
  };

  let result = await attempt(messages, undefined);

  // Потоковий парсер міг пропустити картки (напр., модель повернула JSON без пробілів чи в іншій формі) —
  // добираємо їх із повного тексту.
  for (const obj of extractCardObjects(result.text).objects) accept(obj);

  const truncated = result.finishReason === "length";
  if (truncated) {
    // Дублі серед розібраних карток називаємо окремо: інакше «збережено 0» читається як «модель нічого не написала».
    const dupes = seen - accepted.length;
    const outcome = !seen ? "жодної повної картки не встигло зʼявитися"
      : !accepted.length ? `повних карток було ${seen}, і всі вже є в колоді; решту обрізано`
      : dupes ? `збережено карток: ${accepted.length}, ще ${dupes} вже є в колоді`
      : `збережено карток: ${accepted.length}`;
    problems.push({
      chunk: index + 1, kind: "truncated",
      message: `Відповідь для фрагмента ${index + 1} обрізана лімітом токенів (${settings.maxTokens}): ${outcome}. ` +
        "Зменште «Карток на фрагмент» або збільште ліміт.",
    });
  }

  if (!seen && result.finishReason !== "length") {
    // Нічого не розібралось — одна спроба виправлення з нульовою температурою.
    const retry = await attempt(buildRepairMessages(messages, result.text), 0);
    for (const obj of extractCardObjects(retry.text).objects) accept(obj);
    if (!seen) {
      const preview = (retry.text || result.text).slice(0, 160).replace(/\s+/g, " ");
      problems.push({
        chunk: index + 1, kind: "bad_output",
        message: `Модель не повернула жодної придатної картки для фрагмента ${index + 1}` +
          (preview ? ` (початок відповіді: «${preview}»)` : " (порожня відповідь)") +
          ". Спробуйте інший режим структурованого виводу або меншу температуру.",
      });
    } else {
      problems.push({ chunk: index + 1, kind: "repaired", message: `Фрагмент ${index + 1}: першу відповідь не вдалося розібрати, виправлено повторним запитом.` });
    }
  }

  if (seen && !accepted.length && !truncated) {
    problems.push({ chunk: index + 1, kind: "duplicates", message: `Фрагмент ${index + 1}: усі картки вже є в колоді.` });
  }
}

/** Оцінює відповідь студента проти еталонної. Повертає { verdict: "correct"|"partial"|"wrong", feedback }. */
export async function gradeAnswer({ settings, card, answer, signal, llm = streamChat }) {
  const result = await llm(settings, buildGradeMessages(card, answer), {
    signal, schema: GRADE_SCHEMA, schemaName: "grade", maxTokens: 200, temperature: 0,
  });
  const data = parseJsonLenient(result.text);
  if (!data || !["correct", "partial", "wrong"].includes(data.verdict)) {
    throw new LLMError("bad_output", "Модель не повернула зрозумілої оцінки. Спробуйте ще раз або перевірте себе за еталоном.");
  }
  return { verdict: data.verdict, feedback: typeof data.feedback === "string" ? data.feedback.trim() : "" };
}
