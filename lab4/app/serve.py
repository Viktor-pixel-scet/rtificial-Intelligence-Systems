#!/usr/bin/env python3

import argparse
import http.client
import json
import mimetypes
import socket
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_ROOT = Path(__file__).resolve().parent / "web"
PROXY_PREFIX = "/v1/"
FORWARDED_REQUEST_HEADERS = ("Content-Type", "Accept", "Authorization")
CONTENT_TYPES = {".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
                 ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
                 ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8"}


class AppHandler(BaseHTTPRequestHandler):
    server_version = "CardsmithServe/1.0"

    def log_message(self, fmt, *args):
        if getattr(self.server, "verbose", False):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith(PROXY_PREFIX):
            return self.proxy("GET")
        if path == "/healthz":
            return self.health()
        return self.static(path)

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path.startswith(PROXY_PREFIX):
            return self.proxy("POST")
        self.send_error_json(405, "Тут приймаються лише запити до /v1/*", "method_not_allowed")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.end_headers()

    def send_error_json(self, status, message, kind, **extra):
        data = json.dumps({"error": {"message": message, "type": kind, **extra}}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def health(self):
        reachable, detail = probe_upstream(self.server.upstream)
        data = json.dumps({"ok": True, "upstream": self.server.upstream, "upstream_reachable": reachable,
                           "detail": detail}, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def static(self, url_path):
        relative = urllib.parse.unquote(url_path).lstrip("/") or "index.html"
        target = (WEB_ROOT / relative).resolve()
        if WEB_ROOT != target and WEB_ROOT not in target.parents:
            return self.send_error_json(403, "Заборонено", "forbidden")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self.send_error_json(404, f"Файл {url_path} не знайдено", "not_found")
        data = target.read_bytes()
        ctype = CONTENT_TYPES.get(target.suffix) or mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")  # під час розробки завжди свіжі файли
        self.end_headers()
        self.wfile.write(data)

    def proxy(self, method):
        upstream = urllib.parse.urlsplit(self.server.upstream)
        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b""
        headers = {name: self.headers[name] for name in FORWARDED_REQUEST_HEADERS if self.headers.get(name)}

        connection_class = http.client.HTTPSConnection if upstream.scheme == "https" else http.client.HTTPConnection
        connection = connection_class(upstream.hostname, upstream.port or (443 if upstream.scheme == "https" else 80),
                                      timeout=self.server.timeout_s)
        try:
            try:
                connection.request(method, self.path, body=body, headers=headers)
                response = connection.getresponse()
            except (TimeoutError, socket.timeout):
                return self.send_error_json(504, "Рантайм не відповів вчасно", "upstream_timeout", upstream=self.server.upstream)
            except OSError as error:
                return self.send_error_json(502, f"Не вдалося підключитися до {self.server.upstream}: {error}",
                                            "upstream_unreachable", upstream=self.server.upstream)

            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            self.stream_body(response)
        finally:
            connection.close()

    def stream_body(self, response):
        is_sse = "text/event-stream" in (response.getheader("Content-Type") or "")
        try:
            while True:
                chunk = response.read1(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, http.client.HTTPException) as error:
            if is_sse:
                lost = {"error": {"message": f"зʼєднання з рантаймом обірвалось: {error}", "type": "upstream_lost"}}
                try:
                    self.wfile.write(f"data: {json.dumps(lost, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()
                except OSError:
                    pass


def probe_upstream(upstream, timeout=2.0):
    parts = urllib.parse.urlsplit(upstream)
    connection_class = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    try:
        connection = connection_class(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), timeout=timeout)
        connection.request("GET", "/v1/models")
        status = connection.getresponse().status
        connection.close()
        return status < 500, f"HTTP {status}"
    except OSError as error:
        return False, str(error)

def make_server(host, port, upstream, timeout_s=600, verbose=False):
    server = ThreadingHTTPServer((host, port), AppHandler)
    server.daemon_threads = True
    server.upstream = upstream.rstrip("/")
    server.timeout_s = timeout_s
    server.verbose = verbose
    return server

def main():
    parser = argparse.ArgumentParser(description="Сервер застосунку «Картки з конспекту»: web/ + проксі до рантайму моделі.")
    parser.add_argument("--host", default="127.0.0.1", help="інтерфейс (за замовчуванням лише локальний)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--upstream", default="http://localhost:11434",
                        help="адреса рантайму без /v1: Ollama :11434, llama-server :8080, LM Studio :1234")
    parser.add_argument("--timeout", type=float, default=600, help="таймаут читання від рантайму, секунди (модель може довго завантажуватись)")
    parser.add_argument("--verbose", action="store_true", help="друкувати кожен запит")
    args = parser.parse_args()

    server = make_server(args.host, args.port, args.upstream, args.timeout, args.verbose)
    reachable, detail = probe_upstream(server.upstream)
    print(f"Застосунок:  http://{args.host}:{args.port}/")
    print(f"Рантайм:     {server.upstream}  —  {'доступний' if reachable else 'НЕ ВІДПОВІДАЄ (' + detail + ')'}")
    if not reachable:
        print("             Запустіть рантайм (наприклад, `ollama serve`) — застосунок можна відкрити вже зараз,")
        print("             він сам покаже, коли зʼявиться звʼязок.")
    print("Зупинити: Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nЗупинено.")

if __name__ == "__main__":
    main()
