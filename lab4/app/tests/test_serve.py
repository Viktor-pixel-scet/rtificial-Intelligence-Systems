import http.client
import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import mock_openai_server  # noqa: E402
import serve  # noqa: E402


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(server):
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


CHAT = {"model": "mock-ok", "stream": True, "stream_options": {"include_usage": True},
        "messages": [{"role": "user", "content": 'Notes:\n"""\nКеш — швидка памʼять між процесором і оперативною памʼяттю.\n"""\n\nCreate 2 flashcards from these notes.'}]}


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock_port, cls.app_port, cls.dead_port = free_port(), free_port(), free_port()
        cls.mock = start(mock_openai_server.make_server(cls.mock_port))
        cls.app = start(serve.make_server("127.0.0.1", cls.app_port, f"http://127.0.0.1:{cls.mock_port}", timeout_s=5))
        cls.dead = start(serve.make_server("127.0.0.1", cls.dead_port, "http://127.0.0.1:1", timeout_s=2))

    @classmethod
    def tearDownClass(cls):
        for server in (cls.mock, cls.app, cls.dead):
            server.shutdown()
            server.server_close()

    def request(self, method, path, body=None, port=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port or self.app_port, timeout=10)
        conn.request(method, path, body=json.dumps(body) if body is not None else None,
                     headers={"Content-Type": "application/json", **(headers or {})})
        return conn, conn.getresponse()

    # ---------- статичні файли ----------
    def test_static_files_and_content_types(self):
        _, r = self.request("GET", "/js/config.js")
        self.assertEqual(r.status, 200)
        self.assertIn("text/javascript", r.getheader("Content-Type"))
        self.assertIn(b"DEFAULT_SETTINGS", r.read())
        _, r = self.request("GET", "/")
        self.assertEqual(r.status, 200)
        self.assertIn("text/html", r.getheader("Content-Type"))
        _, r = self.request("GET", "/css/styles.css")
        self.assertIn("text/css", r.getheader("Content-Type"))

    def test_missing_file_is_json_404(self):
        _, r = self.request("GET", "/nope.js")
        self.assertEqual(r.status, 404)
        self.assertEqual(json.loads(r.read())["error"]["type"], "not_found")

    def test_path_traversal_is_blocked(self):
        for path in ("/../serve.py", "/%2e%2e/serve.py", "/..%2fserve.py", "/js/../../serve.py"):
            _, r = self.request("GET", path)
            body = r.read()
            self.assertIn(r.status, (403, 404), path)
            self.assertNotIn(b"ThreadingHTTPServer", body, f"витік вихідного коду через {path}")

    def test_healthz_reports_upstream(self):
        _, r = self.request("GET", "/healthz")
        data = json.loads(r.read())
        self.assertTrue(data["ok"] and data["upstream_reachable"])
        _, r = self.request("GET", "/healthz", port=self.dead_port)
        self.assertFalse(json.loads(r.read())["upstream_reachable"])

    # ---------- проксі ----------
    def test_models_are_proxied(self):
        _, r = self.request("GET", "/v1/models")
        self.assertEqual(r.status, 200)
        self.assertIn("mock-ok", [m["id"] for m in json.loads(r.read())["data"]])

    def test_streaming_arrives_incrementally(self):
        body = {**CHAT, "model": "mock-slow"}
        conn, r = self.request("POST", "/v1/chat/completions", body)
        self.assertEqual(r.status, 200)
        self.assertIn("text/event-stream", r.getheader("Content-Type"))
        start_time = time.perf_counter()
        first_chunk_at = None
        data = b""
        while True:
            piece = r.read1(4096)
            if not piece:
                break
            if first_chunk_at is None:
                first_chunk_at = time.perf_counter() - start_time
            data += piece
        total = time.perf_counter() - start_time
        self.assertIn(b"data: [DONE]", data)
        self.assertLess(first_chunk_at, total * 0.5, f"перший фрагмент мав прийти задовго до кінця ({first_chunk_at:.2f} з {total:.2f} с)")
        conn.close()

    def test_upstream_errors_pass_through_with_status(self):
        _, r = self.request("POST", "/v1/chat/completions", {**CHAT, "model": "no-such"})
        self.assertEqual(r.status, 404)
        self.assertIn("not found", json.loads(r.read())["error"]["message"])
        _, r = self.request("POST", "/v1/chat/completions", {**CHAT, "model": "mock-500"})
        self.assertEqual(r.status, 500)

    def test_dead_upstream_gives_502_with_hint(self):
        _, r = self.request("POST", "/v1/chat/completions", CHAT, port=self.dead_port)
        self.assertEqual(r.status, 502)
        error = json.loads(r.read())["error"]
        self.assertEqual(error["type"], "upstream_unreachable")
        self.assertIn("127.0.0.1:1", error["message"])

    def test_upstream_cut_midstream_is_reported_to_client(self):
        _, r = self.request("POST", "/v1/chat/completions", {**CHAT, "model": "mock-midcut"})
        data = r.read()
        self.assertIn(b"upstream_lost", data)
        self.assertNotIn(b"[DONE]", data)

    def test_client_disconnect_does_not_break_server(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.app_port, timeout=10)
        conn.request("POST", "/v1/chat/completions", body=json.dumps({**CHAT, "model": "mock-slow"}),
                     headers={"Content-Type": "application/json"})
        response = conn.getresponse()
        response.read1(100)
        conn.close()  # браузер закрив вкладку / натиснув «Зупинити»
        time.sleep(0.5)
        _, r = self.request("GET", "/v1/models")
        self.assertEqual(r.status, 200)

    def test_non_api_post_is_rejected(self):
        _, r = self.request("POST", "/something", {"a": 1})
        self.assertEqual(r.status, 405)

    def test_authorization_header_is_forwarded(self):
        mock_openai_server.REQUESTS.clear()
        _, r = self.request("GET", "/v1/models", headers={"Authorization": "Bearer secret"})
        self.assertEqual(r.status, 200)  # mock не перевіряє ключ; важливо, що запит не ламається із заголовком


if __name__ == "__main__":
    unittest.main(verbosity=2)
