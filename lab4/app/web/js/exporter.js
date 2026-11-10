// Експорт колоди: Anki (TSV), CSV і JSON; імпорт JSON назад.

import { makeId } from "./cards.js";

const oneLine = (text) => String(text ?? "").replace(/[\t\r\n]+/g, " ").trim();
const tagify = (tag) => oneLine(tag).replace(/\s+/g, "_");

/** Anki: «Файл → Імпорт» розпізнає службові рядки з #, роздільник — табуляція, третя колонка — теги. */
export function toAnkiTsv(deck) {
  const header = ["#separator:tab", "#html:false", "#tags column:3"];
  const rows = deck.map((c) => [oneLine(c.front), oneLine(c.back), tagify(c.tag)].join("\t"));
  return `${[...header, ...rows].join("\n")}\n`;
}

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export function toCsv(deck) {
  const rows = [["front", "back", "tag", "box"], ...deck.map((c) => [c.front, c.back, c.tag, c.box])];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`; // BOM — щоб Excel впізнав UTF-8
}

export function toJson(deck) {
  return JSON.stringify({ app: "cardsmith", version: 1, cards: deck }, null, 2);
}

/** Імпорт JSON із toJson (або просто масиву карток). Кидає Error із зрозумілим повідомленням. */
export function fromJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("файл не є коректним JSON");
  }
  const list = Array.isArray(data) ? data : data?.cards;
  if (!Array.isArray(list)) throw new Error("у файлі немає списку карток (очікується поле «cards»)");
  const cards = list
    .filter((c) => c && typeof c.front === "string" && typeof c.back === "string" && c.front.trim() && c.back.trim())
    .map((c) => ({
      id: typeof c.id === "string" ? c.id : makeId(),
      front: c.front.trim(),
      back: c.back.trim(),
      tag: typeof c.tag === "string" ? c.tag : "",
      suspect: Boolean(c.suspect),
      box: Number.isInteger(c.box) && c.box >= 1 && c.box <= 5 ? c.box : 1,
      due: Number.isFinite(c.due) ? c.due : 0,
      createdAt: Number.isFinite(c.createdAt) ? c.createdAt : Date.now(),
    }));
  if (!cards.length) throw new Error("у файлі немає жодної придатної картки");
  return cards;
}
