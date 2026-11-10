// Форматування для інтерфейсу: українські множини, тривалість, дата наступного повторення.

/** plural(5, ["картка", "картки", "карток"]) → "карток" */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export const cardsWord = (n) => `${n} ${plural(n, ["картка", "картки", "карток"])}`;
export const charsWord = (n) => `${n} ${plural(n, ["символ", "символи", "символів"])}`;
export const chunksWord = (n) => `${n} ${plural(n, ["фрагмент", "фрагменти", "фрагментів"])}`;

const comma = (n) => n.toFixed(1).replace(".", ",");

export function formatSeconds(seconds) {
  return seconds < 10 ? `${comma(seconds)} с` : `${Math.round(seconds)} с`;
}

export const formatSpeed = (tokensPerS) => `${comma(tokensPerS)} токенів/с`;

/** Коли наступне повторення: «через 3 год», «завтра о 14:05», «12 лист., 09:00». */
export function formatWhen(timestamp, now = Date.now()) {
  const diffMin = Math.round((timestamp - now) / 60000);
  if (diffMin <= 0) return "зараз";
  if (diffMin < 60) return `через ${diffMin} хв`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `через ${diffH} год`;
  return new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}
