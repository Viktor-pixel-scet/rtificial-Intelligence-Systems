// Промпти й JSON-схеми. Інструкції англійською: малі моделі точніше дотримуються їх, ніж українських;
// мова самих карток задається окремим рядком у промпті.

export const CARDS_SCHEMA = {
  type: "object",
  properties: {
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          front: { type: "string" },
          back: { type: "string" },
        },
        required: ["front", "back"],
        additionalProperties: false,
      },
    },
  },
  required: ["cards"],
  additionalProperties: false,
};

export const GRADE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
    feedback: { type: "string" },
  },
  required: ["verdict", "feedback"],
  additionalProperties: false,
};

const LANGUAGE_LINE = {
  uk: "Write every card in Ukrainian.",
  en: "Write every card in English.",
  auto: "Write both the front and the back of every card in the language the notes are written in.",
};

const STYLE_LINE = {
  qa: "Front = a short, self-contained question. Back = a concise answer (one or two sentences).",
  term: "Front = a term or concept name. Back = its definition in one or two sentences.",
};

export function systemPrompt(settings) {
  return [
    "You turn lecture notes into flashcards for spaced repetition.",
    "Rules:",
    "- Use ONLY facts stated in the notes. Never add outside knowledge or guesses.",
    "- One card tests exactly one fact. Skip filler, examples without a point, and trivia.",
    `- ${STYLE_LINE[settings.style] ?? STYLE_LINE.qa}`,
    "- Never repeat a card. The front must make sense without seeing the notes.",
    `- ${LANGUAGE_LINE[settings.language] ?? LANGUAGE_LINE.uk}`,
    'Reply with ONLY a JSON object: {"cards":[{"front":"...","back":"..."}]}. No comments, no markdown.',
  ].join("\n");
}

export function userPrompt(chunk, count) {
  return `Notes:\n"""\n${chunk}\n"""\n\nCreate ${count} flashcards from these notes.`;
}

// Один приклад «конспект → картки» (few-shot) показує модель формат і рівень деталізації.
const EXAMPLE_NOTES =
  "# Кеш процесора\n\nКеш — швидка памʼять між процесором і оперативною памʼяттю. " +
  "Рівні L1, L2 і L3 відрізняються розміром і швидкістю: L1 найменший і найшвидший. " +
  "Коли потрібних даних у кеші немає, відбувається кеш-промах, і дані читаються з повільнішої памʼяті.";

const EXAMPLE_REPLY_UK = {
  cards: [
    { front: "Що таке кеш процесора?", back: "Швидка памʼять між процесором і оперативною памʼяттю." },
    { front: "Який рівень кешу найменший і найшвидший?", back: "L1." },
    { front: "Що відбувається під час кеш-промаху?", back: "Дані читаються з повільнішої памʼяті." },
  ],
};

const EXAMPLE_REPLY_EN = {
  cards: [
    { front: "What is a processor cache?", back: "Fast memory between the processor and main memory." },
    { front: "Which cache level is the smallest and fastest?", back: "L1." },
    { front: "What happens on a cache miss?", back: "The data is read from slower memory." },
  ],
};

const EXAMPLE_NOTES_EN =
  "# Processor cache\n\nA cache is fast memory between the processor and main memory. " +
  "Levels L1, L2 and L3 differ in size and speed: L1 is the smallest and fastest. " +
  "When the needed data is not in the cache, a cache miss occurs and the data is read from slower memory.";

/** Частка кириличних літер серед усіх літер тексту (1 — якщо літер немає, щоб за замовчуванням лишалась українська). */
export function cyrillicShare(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 1;
  const cyrillic = text.match(/[Ѐ-ӿ]/g) ?? [];
  return cyrillic.length / letters.length;
}

/**
 * Повідомлення для генерації карток: system + приклад + запит.
 * Приклад має бути тією мовою, якою мають бути картки: інакше модель копіює мову прикладу
 * і для англійського конспекту при режимі «Як у конспекті» пише українські питання.
 */
export function buildGenerationMessages(settings, chunk, count) {
  const english = settings.language === "en" || (settings.language === "auto" && cyrillicShare(chunk) < 0.3);
  const exampleNotes = settings.language === "auto" && english ? EXAMPLE_NOTES_EN : EXAMPLE_NOTES;
  return [
    { role: "system", content: systemPrompt(settings) },
    { role: "user", content: userPrompt(exampleNotes, 3) },
    { role: "assistant", content: JSON.stringify(english ? EXAMPLE_REPLY_EN : EXAMPLE_REPLY_UK) },
    { role: "user", content: userPrompt(chunk, count) },
  ];
}

/** Повторний запит, якщо перша відповідь не розібралась: показуємо початок поганої відповіді й просимо виправити. */
export function buildRepairMessages(messages, badReply) {
  const preview = badReply.length > 400 ? `${badReply.slice(0, 400)}…` : badReply;
  return [
    ...messages,
    { role: "assistant", content: preview || "(empty)" },
    {
      role: "user",
      content: 'Your previous reply was not valid JSON of the required shape. ' +
        'Reply again with ONLY the JSON object {"cards":[{"front":"...","back":"..."}]}.',
    },
  ];
}

/** Оцінювання відповіді студента (другий крок ланцюжка в режимі повторення). */
export function buildGradeMessages(card, studentAnswer) {
  return [
    {
      role: "system",
      content: [
        "You grade a student's answer against a reference answer.",
        '"correct": same meaning as the reference. "partial": some key part is missing or imprecise. "wrong": contradicts the reference or is unrelated.',
        "Judge by meaning, not by wording. Write one short sentence of feedback in Ukrainian.",
        'Reply with ONLY JSON: {"verdict":"correct"|"partial"|"wrong","feedback":"..."}',
      ].join("\n"),
    },
    {
      role: "user",
      content: `Question: ${card.front}\nReference answer: ${card.back}\nStudent answer: ${studentAnswer}`,
    },
  ];
}
