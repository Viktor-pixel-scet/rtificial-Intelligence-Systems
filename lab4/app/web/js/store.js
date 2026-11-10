// Збереження колоди й налаштувань у localStorage. Сховище може бути недоступним (приватний режим,
// заборона cookies) — тоді застосунок працює далі, просто без памʼяті між сесіями.

import { DEFAULT_SETTINGS } from "./config.js";

const DECK_KEY = "cardsmith.deck.v1";
const SETTINGS_KEY = "cardsmith.settings.v1";
const DRAFT_KEY = "cardsmith.draft.v1";

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createStore(storage = defaultStorage()) {
  const read = (key, fallback) => {
    try {
      const raw = storage?.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    if (!storage) return false;
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  };

  return {
    loadDeck() {
      const deck = read(DECK_KEY, []);
      return Array.isArray(deck) ? deck : [];
    },
    saveDeck: (deck) => write(DECK_KEY, deck),
    loadSettings() {
      return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
    },
    saveSettings: (settings) => write(SETTINGS_KEY, settings),
    // чернетка конспекту, щоб випадкове оновлення сторінки не стирало введений текст
    loadDraft: () => (typeof read(DRAFT_KEY, "") === "string" ? read(DRAFT_KEY, "") : ""),
    saveDraft: (text) => write(DRAFT_KEY, text),
  };
}
