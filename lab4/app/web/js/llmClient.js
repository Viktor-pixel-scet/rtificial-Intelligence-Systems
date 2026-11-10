// Клієнт OpenAI-сумісного API (/v1/chat/completions) зі стрімінгом.
// Працює однаково з Ollama, llama-server, LM Studio та будь-яким іншим сумісним рантаймом.
//
// Усі збої перетворюються на LLMError із полем kind, щоб інтерфейс міг показати зрозуміле повідомлення:
//   unreachable      — сервер не запущено або адреса неправильна
//   connection_lost  — звʼязок обірвався посеред відповіді
//   timeout          — модель не почала або перестала відповідати
//   model_not_found  — такої моделі немає на сервері
//   wrong_server     — відповів не рантайм моделі (напр. сторінку відкрито через python -m http.server)
//   auth             — сервер вимагає ключ API
//   server           — помилка 5xx або повідомлення про помилку всередині стріму
//   http             — інший відхилений запит (400/422 тощо)
//   bad_output       — модель відповіла, але відповідь непридатна
//   aborted          — користувач зупинив генерацію

export class LLMError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "LLMError";
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const trimSlash = (url) => url.replace(/\/+$/, "");

function authHeaders(settings) {
  return settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
}

/** Тіло запиту /chat/completions за поточними налаштуваннями. */
export function buildRequestBody(settings, messages, { schema = null, schemaName = "result", structured, reasoning, maxTokens, temperature } = {}) {
  const body = {
    model: settings.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens ?? settings.maxTokens, // обовʼязковий ліміт: без нього мала модель може зациклитися
    temperature: temperature ?? settings.temperature,
    top_p: settings.topP,
  };
  if (settings.seed !== null && settings.seed !== undefined && settings.seed !== "") body.seed = Number(settings.seed);
  if ((reasoning ?? settings.reasoning) === "none") body.reasoning_effort = "none";
  const mode = schema ? (structured ?? settings.structured) : "off";
  if (mode === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } };
  } else if (mode === "json_object") {
    body.response_format = { type: "json_object" };
  }
  return body;
}

/**
 * Один потоковий запит. Повертає
 * { text, finishReason, usage, ttft, latency, tokens, tokensPerS, reasoningSeen, fallbacks }.
 * Якщо сервер відхилив response_format або reasoning_effort (400/422), повторює запит без них
 * і повідомляє про це в fallbacks.
 */
export async function streamChat(settings, messages, opts = {}) {
  let structured = opts.schema ? settings.structured : "off";
  let reasoning = settings.reasoning;
  const fallbacks = [];
  let lastError;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const result = await attemptOnce(settings, messages, { ...opts, structured, reasoning });
      return { ...result, fallbacks };
    } catch (error) {
      lastError = error;
      const rejected = error instanceof LLMError && error.kind === "http" && [400, 422].includes(error.status);
      if (!rejected) throw error;
      const detail = `${error.body ?? ""} ${error.message}`;
      if (structured !== "off" && /response_format|json_schema|json_object|structured|schema|grammar/i.test(detail)) {
        const next = structured === "json_schema" ? "json_object" : "off";
        fallbacks.push(`сервер не прийняв режим «${structured}» — перемикаюсь на «${next}»`);
        structured = next;
        continue;
      }
      if (reasoning === "none" && /reason|think/i.test(detail)) {
        fallbacks.push("сервер не прийняв reasoning_effort — надсилаю запит без нього");
        reasoning = "default";
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

async function attemptOnce(settings, messages, opts) {
  const { signal, onDelta = () => {}, onReasoning = () => {}, schema, schemaName, structured, reasoning, maxTokens, temperature } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `${trimSlash(settings.baseUrl)}/chat/completions`;
  const body = buildRequestBody(settings, messages, { schema, schemaName, structured, reasoning, maxTokens, temperature });

  if (signal?.aborted) throw new LLMError("aborted", "Генерацію зупинено.");
  const controller = new AbortController();
  const onUserAbort = () => controller.abort();
  signal?.addEventListener("abort", onUserAbort, { once: true });

  let timeoutKind = null;
  let timer = null;
  const arm = (seconds, kind) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timeoutKind = kind;
      controller.abort();
    }, seconds * 1000);
  };

  const started = performance.now();
  let first = null;
  let received = false;
  let text = "";
  let usage = null;
  let finishReason = null;
  let reasoningSeen = false;
  let contentChunks = 0;
  let sawDone = false;

  arm(settings.firstTokenTimeoutS, "first");
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(settings) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw await httpError(response, settings);
    if (!response.body) throw new LLMError("bad_output", "Сервер не повернув потік відповіді.");

    for await (const line of readLines(response.body)) {
      received = true;
      arm(settings.idleTimeoutS, "idle"); // будь-який рядок потоку, навіть службовий, означає, що модель жива
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        continue;
      }
      if (!payload) continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) {
        if (chunk.error.type === "upstream_lost") {
          throw new LLMError("connection_lost", "Звʼязок проксі з рантаймом обірвався під час генерації. Перевірте, що рантайм ще працює.");
        }
        const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "невідома помилка";
        throw new LLMError("server", `Сервер повідомив про помилку під час генерації: ${message}`);
      }
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // Ollama надсилає міркування в полі reasoning, llama-server і vLLM — у reasoning_content
      const thought = delta.reasoning ?? delta.reasoning_content;
      if (thought) {
        reasoningSeen = true;
        onReasoning(thought);
      }
      if (delta.content) {
        if (first === null) first = performance.now();
        text += delta.content;
        contentChunks++;
        onDelta(delta.content);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  } catch (error) {
    if (error instanceof LLMError) throw error;
    if (controller.signal.aborted) {
      if (timeoutKind === "first") {
        throw new LLMError("timeout", `Модель не почала відповідати за ${settings.firstTokenTimeoutS} с. ` +
          "Можливо, вона ще завантажується в памʼять або їй бракує ресурсів — спробуйте ще раз або оберіть меншу модель.");
      }
      if (timeoutKind === "idle") {
        throw new LLMError("timeout", `Модель замовкла на ${settings.idleTimeoutS} с посеред відповіді. ` +
          "Генерацію перервано; уже отримані картки збережено.");
      }
      throw new LLMError("aborted", "Генерацію зупинено.");
    }
    if (received) {
      throw new LLMError("connection_lost", "Звʼязок із сервером обірвався під час генерації. Перевірте, що рантайм ще працює.");
    }
    throw unreachableError(settings, error);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onUserAbort);
  }

  const ended = performance.now();
  if (!sawDone && !finishReason) {
    // Коректний потік завжди закінчується finish_reason або [DONE]; його відсутність — обрив звʼязку.
    throw new LLMError("connection_lost", "Звʼязок із сервером обірвався під час генерації. Перевірте, що рантайм ще працює.");
  }
  if (!text && reasoningSeen) {
    throw new LLMError("bad_output", "Модель лише міркувала й не встигла дати відповідь. " +
      "Вимкніть міркування в налаштуваннях або збільште ліміт токенів.");
  }
  const tokens = usage?.completion_tokens ?? (contentChunks || null);
  return {
    text,
    finishReason,
    usage,
    reasoningSeen,
    tokens,
    ttft: first === null ? null : (first - started) / 1000,
    latency: (ended - started) / 1000,
    tokensPerS: tokens > 1 && first !== null && ended > first ? (tokens - 1) / ((ended - first) / 1000) : null,
  };
}

function unreachableError(settings, cause) {
  return new LLMError("unreachable",
    `Не вдалося підключитися до сервера моделі (${settings.baseUrl}). ` +
    "Запустіть рантайм (наприклад, «ollama serve») і перевірте адресу в налаштуваннях.", { cause });
}

async function httpError(response, settings) {
  const raw = await response.text().catch(() => "");
  const contentType = response.headers.get("content-type") ?? "";
  let message = raw.slice(0, 300);
  let type = "";
  let upstream = "";
  try {
    const data = JSON.parse(raw);
    const err = data.error ?? data;
    message = typeof err === "string" ? err : err.message ?? message;
    type = (typeof err === "object" && err.type) || "";
    upstream = (typeof err === "object" && err.upstream) || "";
  } catch {
    // тіло не JSON — лишаємо сирий текст
  }
  const extra = { status: response.status, body: raw.slice(0, 1000) };

  if (type === "upstream_unreachable" || response.status === 502) {
    return new LLMError("unreachable",
      `Сервер моделі${upstream ? ` (${upstream})` : ""} не відповідає. ` +
      "Запустіть рантайм (наприклад, «ollama serve») і перевірте адресу в налаштуваннях.", extra);
  }
  if (type === "upstream_timeout" || response.status === 504) {
    return new LLMError("timeout", "Сервер моделі не відповів вчасно. Спробуйте ще раз або оберіть меншу модель.", extra);
  }
  if (/text\/html/i.test(contentType) && [404, 405, 501].includes(response.status)) {
    return new LLMError("wrong_server",
      "За цією адресою відповідає не рантайм моделі. Запустіть застосунок командою «python serve.py» " +
      "(а не «python -m http.server») або вкажіть правильну адресу API в налаштуваннях.", extra);
  }
  if (response.status === 404 || /model.*not found|not found.*model/i.test(message)) {
    return new LLMError("model_not_found",
      `Модель «${settings.model}» не знайдена на сервері. Завантажте її (наприклад, «ollama pull ${settings.model}») ` +
      "або виберіть іншу в налаштуваннях.", extra);
  }
  if (response.status === 401 || response.status === 403) {
    return new LLMError("auth", "Сервер відхилив ключ API. Вкажіть правильний ключ у налаштуваннях.", extra);
  }
  if (response.status >= 500) {
    return new LLMError("server", `Помилка сервера моделі (${response.status}): ${message}`, extra);
  }
  return new LLMError("http", `Сервер відхилив запит (${response.status}): ${message}`, extra);
}

async function* readLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // неповний рядок лишаємо до наступного фрагмента
      for (const line of lines) yield line.replace(/\r$/, "");
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, "");
  } finally {
    reader.cancel().catch(() => {}); // при перериванні закриває зʼєднання, тож сервер припиняє генерацію
  }
}

/** Список моделей на сервері (/v1/models). */
export async function listModels(settings, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${trimSlash(settings.baseUrl)}/models`, {
      headers: authHeaders(settings),
      signal: controller.signal,
    });
    if (!response.ok) throw await httpError(response, settings);
    const data = await response.json();
    return (data.data ?? []).map((m) => m.id);
  } catch (error) {
    if (error instanceof LLMError) throw error;
    throw unreachableError(settings, error);
  } finally {
    clearTimeout(timer);
  }
}

const stripLatest = (name) => name.replace(/:latest$/, "");

/** Стан звʼязку для індикатора в шапці: ready | model_missing | unreachable | error. */
export async function checkServer(settings, opts) {
  try {
    const models = await listModels(settings, opts);
    const found = models.some((m) => stripLatest(m) === stripLatest(settings.model));
    return found
      ? { state: "ready", models }
      : { state: "model_missing", models, message: `Моделі «${settings.model}» немає на сервері.` };
  } catch (error) {
    return { state: error.kind === "unreachable" ? "unreachable" : "error", models: [], message: error.message };
  }
}
