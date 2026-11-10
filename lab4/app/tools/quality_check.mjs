#!/usr/bin/env node
// Перевірка якості на 10 власних промптах (пункти 1.4 і 1.5 завдання).
//
// Проганяє конспекти з app/sample_notes/*.md через ту саму логіку, що й застосунок (web/js/pipeline.js),
// і зберігає відповіді моделі в app/quality_runs/<мітка>.md та .json. Потім можна порівняти два запуски.
//
//   node tools/quality_check.mjs --model qwen3:4b --label before
//   node tools/quality_check.mjs --model qwen3:4b-instruct-2507-q8_0 --label after
//   node tools/quality_check.mjs --compare before after
//
// Параметри: --base-url (за замовчуванням http://localhost:11434/v1), --api-key, --context 4096, --max-tokens 1200,
//            --temperature 0 --seed 1 (для порівняння «до/після» потрібна відтворюваність — див. відповідь 0.1.10),
//            --reasoning none|default, --notes <тека>, --out <тека>.
// Потрібен лише Node.js 18+ (без npm-пакетів). Усі конспекти — це ваші «10 промптів»: додайте або замініть файли в sample_notes/.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../web/js/config.js";
import { generateCards } from "../web/js/pipeline.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const fmt = (n, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? "—" : n.toFixed(digits).replace(".", ","));
const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");

async function runAll(args) {
  const label = args.label;
  if (!label || label === true) throw new Error("Вкажіть мітку запуску: --label before (або after).");
  if (!args.model || args.model === true) throw new Error("Вкажіть модель: --model <назва на сервері>.");

  const settings = {
    ...DEFAULT_SETTINGS,
    baseUrl: args["base-url"] || "http://localhost:11434/v1",
    apiKey: args["api-key"] || "",
    model: args.model,
    temperature: args.temperature !== undefined ? Number(args.temperature) : 0,
    seed: args.seed !== undefined ? Number(args.seed) : 1,
    contextTokens: Number(args.context || DEFAULT_SETTINGS.contextTokens),
    maxTokens: Number(args["max-tokens"] || DEFAULT_SETTINGS.maxTokens),
    reasoning: args.reasoning || DEFAULT_SETTINGS.reasoning,
    language: args.language || "auto", // англомовний конспект має давати англомовні картки
  };

  const notesDir = path.resolve(args.notes || path.join(ROOT, "sample_notes"));
  const outDir = path.resolve(args.out || path.join(ROOT, "quality_runs"));
  const files = (await readdir(notesDir)).filter((f) => /\.(md|txt)$/i.test(f)).sort();
  if (!files.length) throw new Error(`У ${notesDir} немає конспектів (.md/.txt).`);

  console.log(`Модель ${settings.model} @ ${settings.baseUrl}, мітка «${label}», конспектів: ${files.length}`);
  const runs = [];
  for (const file of files) {
    const notes = await readFile(path.join(notesDir, file), "utf-8");
    process.stdout.write(`  ${file} … `);
    const started = performance.now();
    const result = await generateCards({ settings, notes });
    const seconds = (performance.now() - started) / 1000;
    runs.push({
      file,
      seconds,
      chunks: result.stats.chunks,
      tokens: result.stats.tokens,
      tokensPerS: result.stats.tokensPerS,
      fatal: result.fatal ? `${result.fatal.kind}: ${result.fatal.message}` : null,
      problems: result.problems.map((p) => p.message),
      cards: result.cards.map((c) => ({ front: c.front, back: c.back, suspect: c.suspect })),
    });
    console.log(result.fatal ? `ПОМИЛКА (${result.fatal.kind})` : `${result.cards.length} карток, ${fmt(seconds)} с`);
    if (result.fatal) {
      console.log(`    ${result.fatal.message}`);
      break; // сервер недоступний — далі немає сенсу
    }
  }

  await mkdir(outDir, { recursive: true });
  const meta = { label, model: settings.model, baseUrl: settings.baseUrl, temperature: settings.temperature, seed: settings.seed,
    maxTokens: settings.maxTokens, contextTokens: settings.contextTokens, reasoning: settings.reasoning, date: new Date().toISOString() };
  await writeFile(path.join(outDir, `${label}.json`), JSON.stringify({ meta, runs }, null, 2), "utf-8");
  await writeFile(path.join(outDir, `${label}.md`), renderRun(meta, runs), "utf-8");
  console.log(`\nЗбережено: ${path.relative(process.cwd(), path.join(outDir, `${label}.md`))} і .json`);
  if (runs.some((r) => r.fatal)) process.exitCode = 1;
}

function renderRun(meta, runs) {
  const lines = [
    `# Якість відповідей: ${meta.label}`,
    "",
    `Модель **${meta.model}**, ${meta.baseUrl}; temperature ${meta.temperature}, seed ${meta.seed}, max_tokens ${meta.maxTokens}, контекст ${meta.contextTokens}, міркування: ${meta.reasoning}. Дата: ${meta.date}.`,
    "",
    "| Конспект | Карток | З них підозрілих | Фрагментів | Час, с | Токенів/с | Проблеми |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of runs) {
    lines.push(`| ${r.file} | ${r.cards.length} | ${r.cards.filter((c) => c.suspect).length} | ${r.chunks ?? "—"} | ${fmt(r.seconds)} | ${fmt(r.tokensPerS)} | ${cell(r.fatal || r.problems.length || "—")} |`);
  }
  for (const r of runs) {
    lines.push("", `## ${r.file}`, "");
    if (r.fatal) lines.push(`**Помилка:** ${r.fatal}`, "");
    for (const p of r.problems) lines.push(`> ${p}`, "");
    r.cards.forEach((c, i) => lines.push(`${i + 1}. ${c.suspect ? "⚠️ " : ""}**${c.front}** — ${c.back}`));
    if (!r.cards.length) lines.push("_(карток немає)_");
  }
  return `${lines.join("\n")}\n`;
}

async function compare(a, b, args) {
  const outDir = path.resolve(args.out || path.join(ROOT, "quality_runs"));
  const load = async (label) => JSON.parse(await readFile(path.join(outDir, `${label}.json`), "utf-8"));
  const [A, B] = [await load(a), await load(b)];
  const lines = [
    `# Порівняння якості: ${a} → ${b}`,
    "",
    `- **${a}**: ${A.meta.model}, temperature ${A.meta.temperature}, seed ${A.meta.seed}`,
    `- **${b}**: ${B.meta.model}, temperature ${B.meta.temperature}, seed ${B.meta.seed}`,
    "",
    `Автоматичні показники нічого не кажуть про правильність змісту: відповіді слід прочитати очима й поставити вердикт (✅ не гірше / ⚠️ трохи гірше / ❌ помітно гірше).`,
    "",
    `| Конспект | Карток ${a} | Карток ${b} | Підозрілих ${a} | Підозрілих ${b} | Час ${a}, с | Час ${b}, с | Вердикт (заповніть) |`,
    "|---|---|---|---|---|---|---|---|",
  ];
  const byFile = new Map(B.runs.map((r) => [r.file, r]));
  for (const ra of A.runs) {
    const rb = byFile.get(ra.file);
    if (!rb) continue;
    lines.push(`| ${ra.file} | ${ra.cards.length} | ${rb.cards.length} | ${ra.cards.filter((c) => c.suspect).length} | ${rb.cards.filter((c) => c.suspect).length} | ${fmt(ra.seconds)} | ${fmt(rb.seconds)} | |`);
  }
  for (const ra of A.runs) {
    const rb = byFile.get(ra.file);
    if (!rb) continue;
    lines.push("", `## ${ra.file}`, "", `**${a}:**`, "");
    ra.cards.forEach((c, i) => lines.push(`${i + 1}. ${c.suspect ? "⚠️ " : ""}${c.front} — ${c.back}`));
    lines.push("", `**${b}:**`, "");
    rb.cards.forEach((c, i) => lines.push(`${i + 1}. ${c.suspect ? "⚠️ " : ""}${c.front} — ${c.back}`));
  }
  const file = path.join(outDir, `compare_${a}_vs_${b}.md`);
  await writeFile(file, `${lines.join("\n")}\n`, "utf-8");
  console.log(`Збережено: ${path.relative(process.cwd(), file)}`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.compare) {
    if (args._.length < 1) throw new Error("Використання: --compare before after");
    await compare(args.compare === true ? args._[0] : args.compare, args._[args.compare === true ? 1 : 0], args);
  } else if (args.help || args.h) {
    console.log("Використання:\n  node tools/quality_check.mjs --model <модель> --label before\n  node tools/quality_check.mjs --compare before after\nДокладніше — на початку файлу.");
  } else {
    await runAll(args);
  }
} catch (error) {
  console.error(`Помилка: ${error.message}`);
  process.exitCode = 1;
}
