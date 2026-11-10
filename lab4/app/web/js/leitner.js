// Інтервальне повторення за системою Лейтнера: п'ять «коробок», чим вища — тим рідше повторюємо.

const DAY_MS = 24 * 60 * 60 * 1000;
export const BOX_DAYS = [0, 1, 3, 7, 21]; // інтервал для коробок 1…5
export const MAX_BOX = BOX_DAYS.length;

/** Нова версія картки після відповіді: «знав» — на коробку вище, «не знав» — назад у першу. */
export function review(card, knew, now = Date.now()) {
  const box = knew ? Math.min(card.box + 1, MAX_BOX) : 1;
  return { ...card, box, due: now + BOX_DAYS[box - 1] * DAY_MS };
}

export function isDue(card, now = Date.now()) {
  return card.due <= now;
}

/** Картки до повторення: спершу з нижчих коробок, потім найдавніші за терміном. */
export function dueQueue(deck, now = Date.now()) {
  return deck.filter((card) => isDue(card, now)).sort((a, b) => a.box - b.box || a.due - b.due);
}

export function deckStats(deck, now = Date.now()) {
  const boxes = Array(MAX_BOX).fill(0);
  for (const card of deck) boxes[card.box - 1]++;
  return { total: deck.length, due: deck.filter((c) => isDue(c, now)).length, boxes };
}
