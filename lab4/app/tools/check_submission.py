#!/usr/bin/env python3
import argparse
import csv
import json
import re
import sys
from pathlib import Path

CSV_COLUMNS = ["label", "model", "concurrency", "requests", "errors", "ttft_p50_s", "ttft_p95_s",
               "tokens_per_s_per_user_p50", "throughput_tokens_per_s", "reasoning"]
VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
PLACEHOLDER = re.compile(r"✏️|ВПИШІТЬ|TODO|<впишіть|\.\.\.\s*$", re.M)

results = []


def check(ok, title, hint=""):
    results.append((ok, title, hint))
    print(f"  [{'✓' if ok else '✗'}] {title}" + (f"\n        → {hint}" if hint and not ok else ""))
    return ok


def warn(title, hint=""):
    print(f"  [!] {title}" + (f"\n        → {hint}" if hint else ""))


def find_lab_dir(arg):
    base = Path(arg).resolve()
    for candidate in (base, base / "lab4"):
        if (candidate / "local_models_demo.ipynb").exists() or (candidate / "app").is_dir():
            return candidate
    return base


def cell_text(cell):
    src = cell.get("source", "")
    return "".join(src) if isinstance(src, list) else src


def check_structure(lab):
    print("\n1. Структура файлів (має збігатися з вимогами точно)")
    check((lab / "local_models_demo.ipynb").is_file(), "lab4/local_models_demo.ipynb", "ноутбук має лежати прямо в lab4/ під цією назвою")
    check((lab / "bench_results.csv").is_file(), "lab4/bench_results.csv", "створюється скриптом bench.py — запустіть його з теки lab4")
    app = lab / "app"
    app_files = [p for p in app.rglob("*") if p.is_file() and "node_modules" not in p.parts] if app.is_dir() else []
    check(app.is_dir() and len(app_files) > 0, "lab4/app/* (код застосунку)", "файли застосунку мають лежати в lab4/app/")
    demo = lab / "demo"
    demo_files = [p for p in demo.rglob("*") if p.is_file()] if demo.is_dir() else []
    check(demo.is_dir(), "lab4/demo/", "створіть теку demo/")
    extras = sorted(p.name for p in lab.iterdir() if p.name not in {"local_models_demo.ipynb", "bench_results.csv", "app", "demo"} and not p.name.startswith("."))
    check(not extras, "у lab4/ немає зайвих файлів поза вимогами", f"зайве в корені lab4: {', '.join(extras)} — перенесіть у app/ або видаліть")
    return app, app_files, demo_files


def check_notebook(lab):
    print("\n2. Ноутбук local_models_demo.ipynb")
    path = lab / "local_models_demo.ipynb"
    if not path.is_file():
        return
    try:
        nb = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        check(False, "ноутбук — коректний JSON", str(error))
        return
    cells = nb.get("cells", [])
    code = [c for c in cells if c.get("cell_type") == "code"]
    with_output = [c for c in code if c.get("outputs")]
    check(nb.get("nbformat") == 4, "формат nbformat 4")
    check(len(code) > 0 and len(with_output) / len(code) >= 0.6, f"клітинки виконано, виводи збережено ({len(with_output)} із {len(code)})",
          "відкрийте у Colab, виконайте «Runtime → Run all», потім «File → Download .ipynb» (виводи зберігаються в файлі)")
    errors = [o for c in code for o in c.get("outputs", []) if o.get("output_type") == "error"]
    check(not errors, "у виводах немає помилок виконання", f"помилок: {len(errors)}, перша: {errors[0].get('ename')}: {errors[0].get('evalue')}" if errors else "")

    markdown = "\n".join(cell_text(c) for c in cells if c.get("cell_type") == "markdown")
    missing = [n for n in range(1, 21) if not re.search(rf"0\.1\.{n}\b", markdown)]
    check(not missing, "є відповіді на всі 20 питань розділу 0.1 (заголовки 0.1.1 … 0.1.20)", f"немає: {missing}")
    check("1.8" in markdown and re.search(r"Залізо", markdown) is not None, "є розділ зі звітом 1.8")

    leftovers = []
    for index, c in enumerate(cells):
        if c.get("cell_type") != "markdown":
            continue
        for line in cell_text(c).splitlines():
            if PLACEHOLDER.search(line):
                leftovers.append((index, line.strip()[:90]))
    check(not leftovers, "жодної незаповненої мітки (✏️ / ВПИШІТЬ / TODO)", "; ".join(f"клітинка {i}: «{t}»" for i, t in leftovers[:5]) + (f" … ще {len(leftovers) - 5}" if len(leftovers) > 5 else ""))


def check_csv(lab):
    print("\n3. bench_results.csv")
    path = lab / "bench_results.csv"
    if not path.is_file():
        return
    with path.open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    check(rows and list(rows[0].keys()) == CSV_COLUMNS, "колонки збігаються з форматом bench.py", f"очікувалось: {', '.join(CSV_COLUMNS)}")
    labels = {r.get("label") for r in rows}
    check("before" in labels, "є запуск з міткою before")
    check("after" in labels, "є запуск з міткою after", "після оптимізації запустіть bench.py з --label after")
    check(all(r.get("errors") in ("0", "", None) for r in rows), "у вимірюваннях немає помилок запитів", "рядки з errors > 0: перемірте")
    if any(str(r.get("reasoning")).lower() == "true" for r in rows):
        warn("у CSV є рядки з reasoning=True", "модель міркувала під час заміру — перемірте з --reasoning-effort none, інакше швидкість завищена")
    models = {(r.get("label"), r.get("model")) for r in rows}
    print(f"        рядків: {len(rows)}; запуски (мітка, модель): {sorted(models)}")
    before = {r["model"] for r in rows if r.get("label") == "before"}
    after = {r["model"] for r in rows if r.get("label") == "after"}
    if before and after and before == after:
        warn("before і after виміряно на одній і тій самій моделі", "це нормально, якщо змінювався рантайм чи його налаштування; інакше перевірте мітки")


def check_app(app, app_files, demo_files):
    print("\n4. Застосунок і демо")
    readme = app / "README.md"
    check(readme.is_file(), "app/README.md з інструкцією запуску", "потрібен md-файл: що встановити, яку модель завантажити, як запустити")
    if readme.is_file():
        text = readme.read_text(encoding="utf-8").lower()
        check(any(k in text for k in ("ollama pull", "ollama run", "llama-server", "lm studio")), "README називає модель і рантайм")
        check(any(k in text for k in ("python", "node", "npm", "go run", "запуск")), "README пояснює, як запустити")
    check(any(p.suffix in {".html", ".py", ".js", ".ts", ".go", ".java", ".rs"} for p in app_files), "у app/ є код")
    videos = [p for p in demo_files if p.suffix.lower() in VIDEO_EXT]
    check(bool(videos), "у demo/ є відео роботи застосунку", "запишіть екран (OBS, QuickTime, Win+G) і покладіть .mp4 у lab4/demo/")
    big = [p.name for p in videos if p.stat().st_size > 90 * 1024 * 1024]
    if big:
        warn(f"відео понад 90 МБ: {', '.join(big)}", "GitHub відхиляє файли понад 100 МБ — стисніть відео або використайте Git LFS")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--lab-dir", default=".", help="тека lab4 або репозиторій, що її містить")
    args = parser.parse_args()
    lab = find_lab_dir(args.lab_dir)
    print(f"Перевіряю: {lab}")
    app, app_files, demo_files = check_structure(lab)
    check_notebook(lab)
    check_csv(lab)
    check_app(app, app_files, demo_files)
    failed = [r for r in results if not r[0]]
    print(f"\nПідсумок: {len(results) - len(failed)} із {len(results)} перевірок пройдено.")
    if failed:
        print("Що виправити:\n" + "\n".join(f"  • {title}" + (f" — {hint}" if hint else "") for _, title, hint in failed))
    else:
        print("Усе гаразд — можна здавати посилання на репозиторій.")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
