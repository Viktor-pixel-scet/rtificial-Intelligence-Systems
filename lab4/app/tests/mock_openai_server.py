#!/usr/bin/env python3

import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = ["mock-ok", "mock-slow", "mock-badjson", "mock-garbage", "mock-truncate", "mock-reasoning",
          "mock-nostruct", "mock-hallucinate", "mock-midcut", "mock-silent", "mock-500"]

LOG_LOCK = threading.Lock()
REQUESTS = []


def sentences_of(notes):
    text = re.sub(r"^#.*$", "", notes, flags=re.M)
    parts = re.split(r"(?<=[.!?…])\s+", " ".join(text.split()))
    return [p.strip() for p in parts if len(p.strip()) > 25]


def make_cards(notes, count, hallucinate=False):
    if hallucinate:
        return [{"front": f"Хто відкрив закон номер {i + 1}?",
                 "back": "Закон відкрили гноми на Марсі у 1887 році під час карнавалу."} for i in range(count)]
    cards = []
    for sentence in sentences_of(notes)[:count]:
        head = " ".join(sentence.split()[:3]).strip(" ,.;:")
        cards.append({"front": f"Що сказано про «{head}»?", "back": sentence})
    return cards


def extract_request(body):
    messages = body.get("messages", [])
    system = messages[0]["content"] if messages and messages[0]["role"] == "system" else ""
    last_user = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    is_grade = "You grade a student's answer" in system
    is_repair = "was not valid JSON" in last_user
    if is_repair:
        users = [m["content"] for m in messages if m["role"] == "user" and "Notes:" in m["content"]]
        last_user = users[-1] if users else ""
    notes_match = re.search(r'Notes:\n"""\n(.*?)\n"""', last_user, re.S)
    count_match = re.search(r"Create (\d+) flashcards", last_user)
    return (notes_match.group(1) if notes_match else "", int(count_match.group(1)) if count_match else 3, is_repair, is_grade)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def write_chunk(self, data: bytes):
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()

    def sse(self, payload):
        text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        self.write_chunk(f"data: {text}\n\n".encode())

    def do_GET(self):
        if self.path == "/v1/models":
            self.send_json(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in MODELS]})
        elif self.path == "/_requests":
            with LOG_LOCK:
                self.send_json(200, REQUESTS[-50:])
        else:
            self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        if self.path == "/_reset":
            with LOG_LOCK:
                REQUESTS.clear()
            return self.send_json(200, {"ok": True})
        if self.path != "/v1/chat/completions":
            return self.send_json(404, {"error": {"message": "not found"}})
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            return self.send_json(400, {"error": {"message": "invalid JSON body"}})
        with LOG_LOCK:
            REQUESTS.append(body)
        try:
            self.chat(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True  # клієнт перервав запит — для тестів це штатна ситуація

    def chat(self, body):
        model = body.get("model", "")
        if model not in MODELS:
            return self.send_json(404, {"error": {"message": f"model '{model}' not found", "type": "api_error"}})
        if model == "mock-500":
            return self.send_json(500, {"error": {"message": "internal error: out of memory"}})
        if model == "mock-nostruct" and "response_format" in body:
            return self.send_json(400, {"error": {"message": "response_format is not supported by this server"}})

        notes, count, is_repair, is_grade = extract_request(body)
        if is_grade:
            content = json.dumps({"verdict": "partial", "feedback": "Відповідь неповна: бракує ключової деталі."}, ensure_ascii=False)
        elif model == "mock-garbage" or (model == "mock-badjson" and not is_repair):
            content = "Ось ваші картки: {front: питання без лапок, back: відповідь} і ще трохи тексту"
        else:
            cards = make_cards(notes, count, hallucinate=(model == "mock-hallucinate"))
            content = json.dumps({"cards": cards}, ensure_ascii=False)

        finish = "stop"
        if model == "mock-truncate":
            content = content[: int(len(content) * 0.6)]
            finish = "length"

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        if model == "mock-silent":
            time.sleep(8)
            return
        delay = 0.15 if model == "mock-slow" else 0.004
        base = {"id": "mock-1", "object": "chat.completion.chunk", "model": model}

        if model == "mock-reasoning" and body.get("reasoning_effort") != "none":
            for thought in ("Давайте подумаємо. ", "Спершу знайду факти. ", "Тепер сформулюю картки. "):
                self.sse({**base, "choices": [{"index": 0, "delta": {"reasoning": thought}, "finish_reason": None}]})
                time.sleep(delay)

        pieces = [content[i:i + 12] for i in range(0, len(content), 12)]
        for index, piece in enumerate(pieces):
            self.sse({**base, "choices": [{"index": 0, "delta": {"content": piece}, "finish_reason": None}]})
            time.sleep(delay)
            if model == "mock-midcut" and index == 3:
                self.close_connection = True
                self.connection.shutdown(2)
                return

        self.sse({**base, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
        if body.get("stream_options", {}).get("include_usage"):
            self.sse({**base, "choices": [], "usage": {"prompt_tokens": 200, "completion_tokens": max(1, len(pieces) * 3),
                                                       "total_tokens": 200 + len(pieces) * 3}})
        self.sse("[DONE]")
        self.write_chunk(b"")  # завершальний чанк


def make_server(port, host="127.0.0.1"):
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=11500)
    args = parser.parse_args()
    srv = make_server(args.port)
    print(f"Mock OpenAI-сервер: http://127.0.0.1:{args.port}/v1  (моделі: {', '.join(MODELS)})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
