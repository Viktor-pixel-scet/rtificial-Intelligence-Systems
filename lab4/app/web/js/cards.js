// Перевірка, нормалізація й дедуплікація карток, а також проста перевірка «чи спирається відповідь на конспект».

const FRONT_KEYS = ["front", "question", "q", "term", "prompt"];
const BACK_KEYS = ["back", "answer", "a", "definition", "response"];
const MAX_FRONT = 220;
const MAX_BACK = 600;

export function makeId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pickText(raw, keys) {
  for (const key of keys) {
    if (typeof raw[key] === "string" && raw[key].trim()) return raw[key];
  }
  return "";
}

function squash(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Скорочує заголовок розділу для мітки картки: по межі слова й із «…», а не посеред слова («процеси, памʼять і с»). */
export function shortTag(text, max = 40) {
  const value = squash(text ?? "");
  if (value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,:;—-]+$/u, "")}…`;
}

/**
 * Заголовок розділу, з якого взято картку, для мітки. Фрагмент може містити кілька розділів, тож «перший заголовок
 * фрагмента» дає хибну мітку (картка про inode потрапляла під «Взаємоблокування»). Обираємо розділ, у якому
 * найбільше слів відповіді (за префіксом із 5 літер); якщо збігу немає, лишаємо перший заголовок фрагмента.
 */
export function sectionTitle(chunk, card) {
  const sections = String(chunk ?? "").split(/^(?=#{1,6}\s)/m)
    .map((part) => {
      const match = part.match(/^#{1,6}\s+(.+)$/m);
      return { title: part.startsWith("#") && match ? match[1] : "", body: part.replace(/^#{1,6}\s+.+$/m, "") };
    });
  const first = (String(chunk ?? "").match(/^#{1,6}\s+(.+)$/m) ?? [])[1] ?? "";
  const stems = (text) => normalizeKey(text).split(" ").filter((w) => w.length > 3).map((w) => w.slice(0, 5));
  const wanted = new Set(stems(`${card.back ?? ""}`));
  if (!wanted.size) return first;
  let best = { title: first, score: 0 };
  for (const section of sections) {
    if (!section.title) continue;
    const have = new Set(stems(section.body));
    let score = 0;
    for (const stem of wanted) if (have.has(stem)) score++;
    if (score > best.score) best = { title: section.title, score };
  }
  return best.title;
}

const endsWithQuestion =(text) => /[?？]["»”)\s]*$/.test(text);

/**
 * Приводить сирий обʼєкт від моделі до картки {front, back}; повертає null, якщо картка непридатна.
 * Мала модель інколи міняє поля місцями (у front — твердження, у back — питання): ця поведінка знайдена
 * у перевірці якості (04_prompt_injection, 07_git_branches) і в тесті на реальній моделі; питання в back —
 * надійна ознака, тож поля повертаються на місце.
 */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let front = squash(pickText(raw, FRONT_KEYS));
  let back = squash(pickText(raw, BACK_KEYS));
  if (endsWithQuestion(back) && !endsWithQuestion(front)) [front, back] = [back, front];
  if (front.length < 3 || back.length < 1) return null;
  if (front.length > MAX_FRONT || back.length > MAX_BACK) return null;
  if (front.toLowerCase() === back.toLowerCase()) return null;
  return { front, back };
}

const normalizeKey = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function wordSet(text) {
  // короткі службові слова відкидаємо, а токени з цифрами (L1, L2, 2024) лишаємо — вони відрізняють картки.
  // Слова порівнюємо за префіксом із 5 літер, бо українські слова відмінюються (взаємоблокування / взаємоблокуванню)
  // і мала модель інколи робить помилку в закінченні чи середині слова («алгорітм»); без цього перефразовані
  // дублі при повторній генерації проходили (виявлено в тесті «повторна генерація» на реальній моделі).
  const words = normalizeKey(text).split(" ").filter((w) => w.length > 2 || /\d/.test(w));
  return new Set(words.map((w) => (/\d/.test(w) ? w : w.slice(0, 5))));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common++;
  return common / (a.size + b.size - common);
}

const BACK_MIN_WORDS = 4;
const BACK_DUP_THRESHOLD = 0.8;

/**
 * Чи це повтор уже наявної картки: однакове питання, дуже схожі питання (Жаккар ≥ 0,75)
 * або практично та сама відповідь (Жаккар ≥ 0,8 для відповідей від 4 слів).
 * Порівняння за відповіддю потрібне, бо при повторній генерації модель перефразовує питання
 * («запобігти» → «уникнути», два питання в одному), але бере те саме речення з конспекту як відповідь.
 */
export function isDuplicate(card, existing) {
  const key = normalizeKey(card.front);
  const words = wordSet(card.front);
  const back = card.back ? wordSet(card.back) : null;
  return existing.some((other) => {
    if (normalizeKey(other.front) === key || jaccard(words, wordSet(other.front)) >= 0.75) return true;
    if (!back || back.size < BACK_MIN_WORDS || !other.back) return false;
    const otherBack = wordSet(other.back);
    return otherBack.size >= BACK_MIN_WORDS && jaccard(back, otherBack) >= BACK_DUP_THRESHOLD;
  });
}

/**
 * Частка «змістовних» слів відповіді, які трапляються в конспекті.
 * Слова порівнюємо за префіксом із 5 літер, бо українські слова відмінюються (кеш/кешу/кешем).
 * Низьке значення — привід підозрювати, що модель вигадала відповідь.
 */
export function groundingScore(card, source) {
  const stem = (word) => word.slice(0, 5);
  const sourceStems = new Set(normalizeKey(source).split(" ").filter((w) => w.length > 3).map(stem));
  const answerWords = normalizeKey(card.back).split(" ").filter((w) => w.length > 3);
  if (!answerWords.length) return 1; // відповідь із коротких слів («L1», «так») перевірити нічим
  const hits = answerWords.filter((w) => sourceStems.has(stem(w))).length;
  return hits / answerWords.length;
}

export const GROUNDING_THRESHOLD = 0.4;

/** Готує картку до збереження в колоді. */
export function toDeckCard(card, { source = "", tag = "" } = {}) {
  const score = groundingScore(card, source);
  return {
    id: makeId(),
    front: card.front,
    back: card.back,
    tag,
    suspect: score < GROUNDING_THRESHOLD,
    box: 1,
    due: 0,
    createdAt: Date.now(),
  };
}
