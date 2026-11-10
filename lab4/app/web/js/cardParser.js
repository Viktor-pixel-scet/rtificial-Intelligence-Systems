// Розбір відповіді моделі. Головне завдання — показувати картки одразу, як тільки модель дописала
// кожен обʼєкт, не чекаючи кінця всього JSON. Тому парсер читає потік посимвольно й віддає
// кожен завершений обʼєкт, який лежить безпосередньо всередині масиву.

export class CardStreamParser {
  constructor() {
    this.stack = [];      // типи контейнерів, у яких ми зараз: "{" або "["
    this.starts = [];     // позиції початку відкритих обʼєктів у this.text
    this.inString = false;
    this.escaped = false;
    this.text = "";
  }

  /** Додає фрагмент тексту; повертає масив нових завершених обʼєктів (розібраних через JSON.parse). */
  push(chunk) {
    const found = [];
    for (const ch of chunk) {
      const index = this.text.length;
      this.text += ch;

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') {
        this.inString = true;
      } else if (ch === "{" || ch === "[") {
        this.stack.push(ch);
        this.starts.push(index);
      } else if (ch === "}" || ch === "]") {
        const open = this.stack.pop();
        const start = this.starts.pop();
        const parent = this.stack[this.stack.length - 1];
        if (open === "{" && ch === "}" && parent === "[") {
          try {
            found.push(JSON.parse(this.text.slice(start, index + 1)));
          } catch {
            // обірваний або зіпсований обʼєкт пропускаємо: решта потоку ще може бути корисною
          }
        }
      }
    }
    return found;
  }
}

/** Прибирає ```json ... ``` та текст навколо першого JSON-обʼєкта. */
export function stripFences(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/** Розбирає JSON-обʼєкт з відповіді моделі; повертає null, якщо не вдалося. */
export function parseJsonLenient(text) {
  const body = stripFences(text);
  try {
    return JSON.parse(body);
  } catch {
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(body.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Витягує картки з повного тексту відповіді: цілий JSON, а якщо він обірваний — усі завершені обʼєкти.
 * Повертає { objects, complete }, де complete = true, якщо вдалося розібрати весь текст як JSON.
 */
export function extractCardObjects(text) {
  const whole = parseJsonLenient(text);
  if (whole) {
    if (Array.isArray(whole)) return { objects: whole, complete: true };
    if (Array.isArray(whole.cards)) return { objects: whole.cards, complete: true };
  }
  const parser = new CardStreamParser();
  return { objects: parser.push(stripFences(text)), complete: false };
}
