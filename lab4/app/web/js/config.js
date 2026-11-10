// Налаштування за замовчуванням і їхнє обґрунтування (те саме показується в діалозі «Налаштування»).

export const DEFAULT_SETTINGS = {
  baseUrl: "/v1",            // той самий origin: serve.py проксує /v1/* до рантайму, тож CORS не потрібен
  apiKey: "",
  model: "qwen3:1.7b",
  temperature: 0.3,
  topP: 0.9,
  seed: null,
  maxTokens: 1200,
  contextTokens: 4096,
  reasoning: "none",         // "none" — вимкнути міркування; "default" — не передавати параметр
  structured: "json_schema", // "json_schema" | "json_object" | "off"
  cardsPerChunk: 6,
  style: "qa",               // "qa" — питання → відповідь, "term" — термін → визначення
  language: "uk",            // "uk" | "en" | "auto"
  firstTokenTimeoutS: 120,   // перший запит може завантажувати модель у памʼять
  idleTimeoutS: 45,          // пауза між фрагментами стріму
};

// Обмеження, які використовує планування фрагментів (chunker.js).
export const LIMITS = {
  promptOverheadTokens: 750, // системний промпт + few-shot приклад + службові слова
  maxChunkChars: 3000,       // менші фрагменти дають точніші картки у малої моделі
  minChunkChars: 800,
  charsPerCard: 300,         // скільки символів конспекту «годує» одну картку
  tokensPerCard: 110,        // питання + відповідь + JSON-обгортка українською
};

// Пояснення параметрів — для UI та README.
export const PARAM_NOTES = {
  temperature: "0,3: картки мають триматися тексту конспекту, тож випадковість мінімальна. " +
    "Але не 0: жадібне декодування на малих моделях частіше зациклюється.",
  topP: "0,9: відсікає зовсім малоймовірні токени, не звужуючи вибір надто сильно.",
  maxTokens: "1200: 6 карток × ≈110 токенів + запас. Ліміт обовʼязковий — без нього мала модель " +
    "може зациклитися й генерувати безкінечно.",
  contextTokens: "4096: промпт (≈750) + фрагмент конспекту (≈1000–1300) + відповідь (≤1200) вміщаються " +
    "з запасом. Більший контекст збільшує KV-кеш і сповільнює модель без користі для цієї задачі. " +
    "Сам контекст задається на сервері (OLLAMA_CONTEXT_LENGTH, -c у llama-server); тут він потрібен лише для планування.",
  reasoning: "Вимкнено: для вилучення фактів міркування не потрібне, а коштує сотні токенів і секунди очікування.",
  structured: "json_schema: сервер сам змушує модель видати валідний JSON потрібної форми.",
};

/**
 * Перевірка налаштувань з діалогу. Повертає масив повідомлень про помилки (порожній — усе гаразд).
 * Головна перевірка: відповідь + промпт мають вміщатися в контекст сервера.
 */
export function validateSettings(c) {
  const errors = [];
  const inRange = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
  if (!String(c.baseUrl ?? "").trim() || !/^(\/|https?:\/\/)/.test(c.baseUrl.trim())) {
    errors.push("Адреса API має починатися з «/» (через serve.py) або з http:// чи https://.");
  }
  if (!String(c.model ?? "").trim()) errors.push("Вкажіть назву моделі.");
  if (!inRange(c.temperature, 0, 2)) errors.push("Temperature має бути від 0 до 2.");
  if (!inRange(c.topP, 0.05, 1)) errors.push("Top-p має бути від 0,05 до 1.");
  if (!Number.isInteger(c.maxTokens) || !inRange(c.maxTokens, 100, 16000)) {
    errors.push("Ліміт токенів відповіді — ціле число від 100 до 16000 (без ліміту мала модель може зациклитися).");
  }
  if (!Number.isInteger(c.contextTokens) || !inRange(c.contextTokens, 1024, 262144)) {
    errors.push("Контекст — ціле число від 1024 до 262144 токенів.");
  } else if (Number.isInteger(c.maxTokens) && c.maxTokens + LIMITS.promptOverheadTokens + 400 > c.contextTokens) {
    errors.push(`Відповідь (${c.maxTokens}) і промпт (≈${LIMITS.promptOverheadTokens}) не залишають місця для конспекту в контексті ${c.contextTokens}. ` +
      "Зменште ліміт відповіді або збільште контекст.");
  }
  if (c.seed !== null && !Number.isInteger(c.seed)) errors.push("Seed має бути цілим числом або порожнім.");
  if (!inRange(c.firstTokenTimeoutS, 5, 1800)) errors.push("Таймаут першого токена — від 5 до 1800 секунд.");
  if (!inRange(c.idleTimeoutS, 5, 600)) errors.push("Таймаут паузи — від 5 до 600 секунд.");
  return errors;
}
