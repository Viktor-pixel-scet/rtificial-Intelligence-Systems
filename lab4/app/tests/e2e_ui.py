import argparse
import json
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import mock_openai_server  # noqa: E402
import serve  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NOTES_WITH_HTML = (
    "# Безпека\n\nМодель не повинна виконувати розмітку: <b>жирний</b> текст і <img src=x onerror=alert(1)> "
    "мають показуватися як звичайні символи, а не як елементи сторінки.\n\n"
    "Другий факт полягає в тому, що відповідь модель завжди вставляється через textContent."
)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Runner:
    def __init__(self, shots):
        self.shots = Path(shots) if shots else None
        if self.shots:
            self.shots.mkdir(parents=True, exist_ok=True)
        self.passed = []

    def check(self, name, condition, detail=""):
        status = "OK  " if condition else "FAIL"
        print(f"  [{status}] {name}{(' — ' + str(detail)) if detail and not condition else ''}")
        if not condition:
            raise AssertionError(f"{name}: {detail}")
        self.passed.append(name)

    def shot(self, page, name, full=False):
        if self.shots:
            page.screenshot(path=str(self.shots / f"{name}.png"), full_page=full)


def set_model(page, model, **extra):
    page.click("#openSettings")
    page.fill("#s-model", model)
    for key, value in extra.items():
        page.fill(f"#s-{key}", str(value))
    page.click("#saveSettings")
    page.wait_for_function("!document.getElementById('settingsDialog').open")


def run_generation(page):
    page.click("#generate")
    page.wait_for_function("document.getElementById('generate').disabled === false", timeout=60000)


def notices(page, selector="#notices"):
    return page.eval_on_selector_all(f"{selector} .notice", "els => els.map(e => e.textContent)")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots", help="куди зберігати скриншоти")
    args = parser.parse_args()
    t = Runner(args.shots)

    mock_port, app_port, dead_port = free_port(), free_port(), free_port()
    start(mock_openai_server.make_server(mock_port))
    start(serve.make_server("127.0.0.1", app_port, f"http://127.0.0.1:{mock_port}", timeout_s=10))
    start(serve.make_server("127.0.0.1", dead_port, "http://127.0.0.1:1", timeout_s=2))
    url, dead_url = f"http://127.0.0.1:{app_port}/", f"http://127.0.0.1:{dead_port}/"
    download_dir = tempfile.mkdtemp()

    with sync_playwright() as p:
        launch = {"headless": True}
        chrome = os.environ.get("CHROME_PATH") or ("/opt/pw-browsers/chromium-1194/chrome-linux/chrome" if Path("/opt/pw-browsers/chromium-1194/chrome-linux/chrome").exists() else None)
        if chrome:
            launch["executable_path"] = chrome
        browser = p.chromium.launch(**launch)
        context = browser.new_context(viewport={"width": 1280, "height": 860}, accept_downloads=True, locale="uk-UA")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)

        print("1. Завантаження сторінки й стан звʼязку")
        page.goto(url)
        page.wait_for_function("document.getElementById('status').dataset.state !== 'checking'")
        t.check("заголовок сторінки", page.title() == "Картки з конспекту")
        t.check("типова модель відсутня на сервері → стан model_missing", page.get_attribute("#status", "data-state") == "model_missing")
        t.check("повідомлення називає модель", "qwen3:1.7b" in page.inner_text("#statusText"))
        page.click("#generate")
        t.check("порожній конспект → зрозуміле попередження", any("замалий" in n for n in notices(page)), notices(page))

        print("2. Налаштування: валідація й збереження")
        page.click("#openSettings")
        t.check("діалог відкрито", page.evaluate("document.getElementById('settingsDialog').open"))
        t.check("пояснення параметрів підставлено", "зациклитися" in page.inner_text("[data-note=maxTokens]"))
        t.check("список моделей із сервера в datalist", page.eval_on_selector_all("#modelList option", "o => o.length") >= 5)
        page.fill("#s-maxTokens", "3900")
        page.fill("#s-contextTokens", "4096")
        page.click("#saveSettings")
        t.check("відповідь, що не вміщається в контекст, відхиляється", page.is_visible("#settingsError") and "контексті" in page.inner_text("#settingsError"))
        t.check("діалог лишається відкритим при помилці", page.evaluate("document.getElementById('settingsDialog').open"))
        page.fill("#s-maxTokens", "1200")
        page.fill("#s-model", "mock-slow")
        page.fill("#s-temperature", "0.25")
        t.shot(page, "03-settings")
        page.click("#saveSettings")
        page.wait_for_function("!document.getElementById('settingsDialog').open")
        page.wait_for_function("document.getElementById('status').dataset.state === 'ready'")
        t.check("після вибору наявної моделі стан ready", True)

        print("3. Генерація зі стрімінгом")
        page.click("#sample")
        t.check("приклад вставлено, план показано", "фрагмент" in page.inner_text("#plan"), page.inner_text("#plan"))
        t.shot(page, "01-before-generate")
        page.click("#generate")
        page.wait_for_selector("#fresh .index-card")
        t.check("під час генерації кнопка «Зупинити» видима, «Створити» вимкнена",
                page.is_visible("#stop") and page.is_disabled("#generate"))
        first_count = page.eval_on_selector_all("#fresh .index-card", "c => c.length")
        page.wait_for_function("document.getElementById('generate').disabled === false", timeout=60000)
        final_count = page.eval_on_selector_all("#fresh .index-card", "c => c.length")
        t.check("картки зʼявилися поступово (спершу менше, ніж у фіналі)", first_count < final_count, f"{first_count} → {final_count}")
        t.check("індикатор прогресу прихований після завершення", not page.is_visible("#progress"))
        t.check("підсумок «Готово» зі швидкістю", any("Готово" in n for n in notices(page)), notices(page))
        t.check("сирий вихід моделі доступний", len(page.text_content("#raw")) > 50)
        saved_notes = page.input_value("#notes")
        page.fill("#notes", "")
        page.click("#generate")
        t.check("порожній конспект після генерації: попередження є", any("замалий" in n for n in notices(page)), notices(page))
        t.check("порожній конспект після генерації: старий сирий вихід прибрано", page.is_hidden("#rawBox") and page.text_content("#raw") == "")
        page.fill("#notes", "ab")
        t.check("лічильник відмінює «символи»", "2 символи" in page.inner_text("#counter"), page.inner_text("#counter"))
        page.fill("#notes", saved_notes)
        t.check("лічильник у вкладці «Колода»", page.inner_text("#deckCount") == str(final_count))
        t.shot(page, "02-generated")

        print("4. Безпека: HTML від моделі не стає розміткою")
        page.fill("#notes", NOTES_WITH_HTML)
        run_generation(page)
        t.check("тег <b> показано текстом", "<b>жирний</b>" in page.inner_text("#fresh"))
        t.check("елементів b/img у картках немає", page.eval_on_selector_all("#fresh b, #fresh img", "e => e.length") == 0)

        print("5. Повторна генерація не дублює колоду")
        before = page.inner_text("#deckCount")
        page.click("#sample")
        run_generation(page)
        t.check("дублікатів не додано", page.inner_text("#deckCount") == before, f"{before} → {page.inner_text('#deckCount')}")
        t.check("пояснення про дублікати", any("вже є в колоді" in n for n in notices(page)), notices(page))

        print("6. Колода й експорт")
        page.click("#tab-deck")
        t.check("картки в колоді", page.eval_on_selector_all("#deckList .index-card", "c => c.length") == int(before))
        with page.expect_download() as d:
            page.click("#exportAnki")
        anki = Path(download_dir, "anki.txt")
        d.value.save_as(anki)
        text = anki.read_text(encoding="utf-8")
        t.check("Anki TSV має службові рядки й 3 колонки", text.startswith("#separator:tab\n#html:false\n#tags column:3\n") and all(len(r.split("\t")) == 3 for r in text.splitlines()[3:]))
        with page.expect_download() as d:
            page.click("#exportJson")
        js = Path(download_dir, "deck.json")
        d.value.save_as(js)
        exported = json.loads(js.read_text(encoding="utf-8"))
        t.check("JSON-експорт містить усі картки", len(exported["cards"]) == int(before))
        page.once("dialog", lambda dlg: dlg.accept())
        page.click("#clearDeck")
        t.check("очищення колоди", page.eval_on_selector_all("#deckList .index-card", "c => c.length") == 0 and page.is_visible("#deckEmpty"))
        page.set_input_files("#importJson", str(js))
        page.wait_for_selector("#deckList .index-card")
        t.check("імпорт повертає всі картки", page.eval_on_selector_all("#deckList .index-card", "c => c.length") == int(before))
        bad = Path(download_dir, "bad.json")
        bad.write_text("це не json", encoding="utf-8")
        page.set_input_files("#importJson", str(bad))
        page.wait_for_selector("#deckNotices .notice.error")
        t.check("поганий файл імпорту → зрозуміла помилка", "коректним JSON" in page.inner_text("#deckNotices"))
        t.shot(page, "04-deck")

        print("7. Повторення (Leitner) і перевірка відповіді моделлю")
        page.click("#tab-study")
        t.check("є картки в черзі", page.is_visible("#studyBox"))
        total_due = int(page.inner_text("#dueCount"))
        front = page.inner_text("#studyFront")
        t.check("відповідь прихована до натискання", not page.is_visible("#studyBack"))
        page.fill("#myAnswer", "Якась памʼять")
        page.click("#checkAnswer")
        page.wait_for_selector("#gradeResult:not([hidden])")
        page.wait_for_function("document.getElementById('gradeResult').dataset.verdict")
        t.check("модель оцінила відповідь", "Частково" in page.inner_text("#gradeResult"), page.inner_text("#gradeResult"))
        t.check("після оцінки показано еталон", page.is_visible("#studyBack"))
        t.shot(page, "05-study")
        page.click("#know")
        t.check("«Знав» зменшує чергу", int(page.inner_text("#dueCount")) == total_due - 1)
        t.check("наступна картка інша", page.inner_text("#studyFront") != front)
        page.keyboard.press("Space")
        t.check("пробіл відкриває відповідь", page.is_visible("#studyBack"))
        page.keyboard.press("1")
        t.check("клавіша «1» — не знав: картка повертається в чергу", int(page.inner_text("#dueCount")) == total_due - 1)
        while page.is_visible("#studyBox"):
            page.keyboard.press("Space")
            page.keyboard.press("2")
            if int(page.inner_text("#dueCount") or 0) == 0:
                break
        page.wait_for_selector("#studyEmpty:not([hidden])")
        t.check("порожня черга: повідомлення про наступне повторення", "Наступна картка" in page.inner_text("#studyEmpty") or "все повторено" in page.inner_text("#studyEmpty"), page.inner_text("#studyEmpty"))

        print("8. Збої: кожен має зрозуміле повідомлення")
        page.click("#tab-create")
        page.click("#sample")
        scenarios = [
            ("no-such-model", "не знайдена", {}),
            ("mock-500", "Помилка сервера моделі", {}),
            ("mock-garbage", "жодної придатної картки", {}),
            ("mock-truncate", "обрізана лімітом токенів", {}),
            ("mock-midcut", "обірвався", {}),
            ("mock-hallucinate", "Перевірте за конспектом", {}),
            ("mock-nostruct", "Сумісність із сервером", {}),
        ]
        for model, expected, extra in scenarios:
            set_model(page, model, **extra)
            run_generation(page)
            joined = " | ".join(notices(page))
            t.check(f"{model}: «{expected}»", expected in joined or expected in page.inner_text("#fresh"), joined)
            if model == "mock-hallucinate":
                t.check("підозрілі картки мають позначку", page.eval_on_selector_all("#fresh .badge", "b => b.length") >= 1)
                t.shot(page, "06-suspect-cards")
            if model == "mock-500":
                t.shot(page, "07-error-server")

        set_model(page, "mock-silent", firstTokenTimeoutS=5)
        run_generation(page)
        t.check("mock-silent: таймаут із поясненням", any("не почала відповідати" in n for n in notices(page)), notices(page))

        print("9. Сервер моделі не запущено")
        page.goto(dead_url)
        page.wait_for_function("document.getElementById('status').dataset.state !== 'checking'")
        t.check("індикатор: немає звʼязку", page.get_attribute("#status", "data-state") == "unreachable", page.get_attribute("#status", "data-state"))
        page.click("#sample")
        run_generation(page)
        msg = " | ".join(notices(page))
        t.check("повідомлення підказує запустити рантайм", "не відповідає" in msg and "ollama serve" in msg, msg)
        t.shot(page, "08-error-unreachable")

        print("10. Зупинка генерації користувачем")
        page.goto(url)
        page.wait_for_function("document.getElementById('status').dataset.state !== 'checking'")
        set_model(page, "mock-slow", firstTokenTimeoutS=60)
        long_notes = "\n\n".join(f"Факт номер {i} стверджує, що компонент {i} архітектури процесора працює з частотою {i * 100} мегагерц у режимі {i}." for i in range(40))
        page.fill("#notes", long_notes)
        page.fill("#cardsPerChunk", "4")
        page.click("#generate")
        page.wait_for_selector("#fresh .index-card")
        page.click("#stop")
        page.wait_for_function("document.getElementById('generate').disabled === false", timeout=30000)
        t.check("після «Зупинити» є повідомлення й картки збережено",
                any("зупинено" in n.lower() for n in notices(page)) and page.eval_on_selector_all("#fresh .index-card", "c => c.length") >= 1, notices(page))

        print("11. Памʼять між сесіями")
        deck_before = page.inner_text("#deckCount")
        page.reload()
        page.wait_for_function("document.getElementById('status').dataset.state !== 'checking'")
        t.check("колода збережена після перезавантаження", page.inner_text("#deckCount") == deck_before)
        t.check("чернетка конспекту збережена", page.input_value("#notes").startswith("Факт номер 0"))
        t.check("налаштування збережені", page.evaluate("JSON.parse(localStorage.getItem('cardsmith.settings.v1')).model") == "mock-slow")

        print("12. Темна тема, мобільний екран, клавіатура")
        t.check("вкладки перемикаються стрілками",
                (page.focus("#tab-create"), page.keyboard.press("ArrowRight"), page.get_attribute("#tab-study", "aria-selected"))[2] == "true")
        page.click("#tab-create")
        dark = browser.new_context(viewport={"width": 1280, "height": 860}, color_scheme="dark", locale="uk-UA")
        dpage = dark.new_page()
        dpage.goto(url)
        dpage.click("#sample")
        dpage.wait_for_function("document.getElementById('status').dataset.state !== 'checking'")
        t.shot(dpage, "09-dark")
        mobile = browser.new_context(viewport={"width": 390, "height": 800}, locale="uk-UA")
        mpage = mobile.new_page()
        mpage.goto(url)
        mpage.click("#sample")
        mpage.wait_for_function("document.getElementById('status').dataset.state !== 'checking'")
        overflow = mpage.evaluate("document.documentElement.scrollWidth - window.innerWidth")
        t.check("на екрані 390 px немає горизонтальної прокрутки", overflow <= 0, f"надлишок {overflow}px")
        t.shot(mpage, "10-mobile", full=True)

        t.check("жодних помилок у консолі браузера", not errors, errors)
        browser.close()

    print(f"\nУсього перевірок: {len(t.passed)} — усі пройдено.")


if __name__ == "__main__":
    main()
