// Розбиття конспекту на фрагменти, які вміщаються в контекст моделі разом з промптом і відповіддю.

import { LIMITS } from "./config.js";

const CYRILLIC = /[\u0400-\u04FF]/g;
const HEADING = /^#{1,6}\s/;

/** Груба оцінка кількості токенів: кирилиця токенізується гірше за латиницю (≈2,4 проти ≈3,8 символа/токен). */
export function estimateTokens(text) {
  const cyr = (text.match(CYRILLIC) || []).length;
  const rest = text.length - cyr;
  return Math.ceil(cyr / 2.4 + rest / 3.8);
}

/**
 * Скільки символів конспекту можна віддати моделі в одному запиті.
 * Бюджет контексту: промпт + фрагмент + відповідь ≤ контекст (з запасом 10 %).
 */
export function chunkBudgetChars(settings) {
  const free = (settings.contextTokens - LIMITS.promptOverheadTokens - settings.maxTokens) * 0.9;
  const chars = Math.floor(free * 2.4);
  return Math.max(LIMITS.minChunkChars, Math.min(LIMITS.maxChunkChars, chars));
}

/** Скільки карток просити для фрагмента: приблизно одну на кожні ~450 символів, але не більше за налаштування. */
export function cardsForChunk(chunk, settings) {
  const byLength = Math.round(chunk.length / LIMITS.charsPerCard);
  return Math.max(2, Math.min(settings.cardsPerChunk, byLength));
}

/**
 * Ділить текст на фрагменти ≤ maxChars, не розрізаючи абзаци без потреби.
 * Якщо фрагмент не починається із заголовка Markdown, додає попередній заголовок — модель бачить тему.
 */
export function splitIntoChunks(text, maxChars) {
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [];

  const blocks = clean.split(/\n{2,}/).flatMap((block) => splitLongBlock(block.trim(), maxChars)).filter(Boolean);

  const chunks = [];
  let current = [];
  let size = 0;
  let heading = "";       // останній заголовок, побачений до початку поточного фрагмента
  let chunkHeading = "";  // заголовок, з яким починається поточний фрагмент

  const flush = () => {
    if (!current.length) return;
    const body = current.join("\n\n");
    const startsWithHeading = HEADING.test(body);
    chunks.push(!startsWithHeading && chunkHeading ? `${chunkHeading}\n\n${body}` : body);
    current = [];
    size = 0;
  };

  for (const block of blocks) {
    const isHeading = HEADING.test(block);
    if (size && size + block.length + 2 > maxChars) {
      // заголовок не лишаємо «висіти» в кінці фрагмента: переносимо його до наступного
      const last = current[current.length - 1];
      const carry = current.length > 1 && HEADING.test(last) ? current.pop() : null;
      flush();
      if (carry) {
        current.push(carry);
        size = carry.length + 2;
        chunkHeading = "";  // фрагмент і так починається із заголовка
      }
    }
    if (!current.length) chunkHeading = heading;
    current.push(block);
    size += block.length + 2;
    if (isHeading) heading = block.split("\n")[0];
  }
  flush();

  return mergeTinyHeadingOnlyChunks(chunks);
}

/** Блок довший за ліміт ділимо за реченнями, а якщо й це не допомагає — жорстко за довжиною. */
function splitLongBlock(block, maxChars) {
  if (block.length <= maxChars) return [block];
  const sentences = block.split(/(?<=[.!?…])\s+/);
  const parts = [];
  let buf = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      if (buf) parts.push(buf);
      buf = "";
      for (let i = 0; i < sentence.length; i += maxChars) parts.push(sentence.slice(i, i + maxChars));
      continue;
    }
    if (buf && buf.length + sentence.length + 1 > maxChars) {
      parts.push(buf);
      buf = sentence;
    } else {
      buf = buf ? `${buf} ${sentence}` : sentence;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/** Фрагмент, що складається лише із заголовка, не дає моделі фактів — приєднуємо його до сусіднього. */
function mergeTinyHeadingOnlyChunks(chunks) {
  const out = [];
  for (const chunk of chunks) {
    const headingOnly = /^#{1,6}\s[^\n]*$/.test(chunk.trim());
    if (headingOnly && out.length === 0) {
      out.push(chunk);
    } else if (out.length && /^#{1,6}\s[^\n]*$/.test(out[out.length - 1].trim())) {
      out[out.length - 1] = `${out[out.length - 1]}\n\n${chunk}`;
    } else {
      out.push(chunk);
    }
  }
  return out;
}

/** План генерації для показу користувачеві ще до запуску. */
export function planGeneration(text, settings) {
  const maxChars = chunkBudgetChars(settings);
  const chunks = splitIntoChunks(text, maxChars);
  const cards = chunks.reduce((sum, chunk) => sum + cardsForChunk(chunk, settings), 0);
  return { chunks, maxChars, expectedCards: cards, inputTokens: estimateTokens(text) };
}
