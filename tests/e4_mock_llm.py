"""A mock of the rewriter's model server for the story_engine=e4 tests. LOCALHOST ONLY: it calls nothing, it only answers.

Serves the two wires E4 speaks: Anthropic-style ``POST /v1/messages`` (ninfer-serve) and ``POST /v1/chat/completions`` (llama.cpp, Strata).
A request is answered by REPLAY: its normalised text (system + every message's text, pictures as ``<image>``) is looked up among the
requests of a stored real E4 run, and the reply that run got is returned. Replies are served in recorded order for a request that was made
more than once. E4's requests are a function of the replies before them, so replaying a recorded run reproduces it request for request; a
request with no recording gets HTTP 599 and is listed in ``misses``.

  python tests/e4_mock_llm.py record <E4 run dir (<out>/<story>)> <fixture.json.gz>   build a fixture from the request/response files of a run
  python tests/e4_mock_llm.py serve <fixture.json.gz> [--port N]
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_ID = "mock-swift-1.5"


def _text(content) -> str:
    if isinstance(content, str):
        return content
    return "\n".join(p.get("text", "") if p.get("type") == "text" else "<image>" for p in content)


def request_text(body: dict) -> list:
    """[system, [[role, text], ...]] of a request body from either wire."""
    system = []
    top = body.get("system")
    if isinstance(top, str):
        system.append(top)
    elif isinstance(top, list):
        system.append("\n".join(b.get("text", "") for b in top))
    messages = []
    for m in body.get("messages", []):
        if m["role"] == "system":
            system.append(_text(m["content"]))
        else:
            messages.append([m["role"], _text(m["content"])])
    return ["\n\n".join(system), messages]


def request_key(body: dict) -> str:
    return hashlib.sha1(json.dumps(request_text(body), ensure_ascii=False).encode("utf-8")).hexdigest()


def reply_text(raw: str) -> str:
    """The answer text of a stored response from either wire ('' when there is none)."""
    try:
        data = json.loads(raw)
    except ValueError:
        return ""
    if isinstance(data.get("content"), list):
        return "".join(b.get("text", "") for b in data["content"] if b.get("type") == "text")
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        return ""


def record(run_dir: Path, out: Path) -> dict:
    fixture = {}
    for req in sorted(run_dir.rglob("*.request.json")):
        resp = req.with_name(req.name.replace(".request.json", ".response.raw.txt"))
        if not resp.is_file():
            continue
        text = reply_text(resp.read_text(encoding="utf-8"))
        if not text.strip():
            continue
        fixture.setdefault(request_key(json.loads(req.read_text(encoding="utf-8"))), []).append(text)
    with gzip.open(out, "wt", encoding="utf-8") as handle:
        json.dump(fixture, handle, ensure_ascii=False)
    return fixture


class MockLLM:
    """``with MockLLM(fixture, mapping=fn) as llm:`` then ``llm.url``; ``llm.requests`` holds every body seen, ``llm.misses`` the unanswered ones."""

    def __init__(self, fixture: dict | Path | None = None, mapping=None, port: int = 0, refuse_images_on_messages: bool = False):
        if isinstance(fixture, (str, Path)):
            with gzip.open(fixture, "rt", encoding="utf-8") as handle:
                fixture = json.load(handle)
        self.fixture = {k: list(v) for k, v in (fixture or {}).items()}
        self.served = {}
        self.mapping = mapping
        self.refuse_images_on_messages = refuse_images_on_messages
        self.requests = []
        self.misses = []
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, code, payload):
                data = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path.rstrip("/") == "/v1/models":
                    self._send(200, {"data": [{"id": MODEL_ID}]})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                wire = "messages" if self.path.rstrip("/") == "/v1/messages" else "chat"
                if self.path.rstrip("/") not in ("/v1/messages", "/v1/chat/completions"):
                    return self._send(404, {"error": "not found"})
                if wire == "messages" and outer.refuse_images_on_messages and any(p.get("type") == "image" for m in body.get("messages", []) if isinstance(m["content"], list) for p in m["content"]):
                    with outer.lock:
                        outer.requests.append({"wire": wire, "key": "refused-images", "body": body})
                    return self._send(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "image content is not supported on this wire"}})
                text = outer.answer(body, wire)
                if text is None:
                    return self._send(599, {"error": "no recording for this request"})
                if wire == "messages":
                    self._send(200, {"id": "mock", "type": "message", "role": "assistant", "model": MODEL_ID,
                                     "content": [{"type": "thinking", "thinking": "(replayed)"}, {"type": "text", "text": text}], "stop_reason": "end_turn",
                                     "usage": {"input_tokens": 1000, "output_tokens": 600, "output_tokens_details": {"thinking_tokens": 100}}})
                else:
                    self._send(200, {"id": "mock", "model": MODEL_ID, "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text, "reasoning_content": "(replayed)"}}],
                                     "usage": {"prompt_tokens": 1000, "completion_tokens": 600}})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def answer(self, body: dict, wire: str):
        key = request_key(body)
        with self.lock:
            self.requests.append({"wire": wire, "key": key, "body": body})
            options = self.fixture.get(key)
            if options:
                i = self.served.get(key, 0)
                self.served[key] = i + 1
                return options[min(i, len(options) - 1)]
        system, messages = request_text(body)
        text = messages[-1][1] if messages else ""
        if self.mapping is not None and "binding the reference pictures" in text:
            return self.mapping(text)
        with self.lock:
            self.misses.append({"wire": wire, "key": key, "head": text[:200]})
        return None

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("run_dir")
    r.add_argument("out")
    s = sub.add_parser("serve")
    s.add_argument("fixture")
    s.add_argument("--port", type=int, default=0)
    a = ap.parse_args()
    if a.cmd == "record":
        fx = record(Path(a.run_dir), Path(a.out))
        print(f"{len(fx)} distinct requests, {sum(len(v) for v in fx.values())} replies -> {a.out}")
    else:
        with MockLLM(Path(a.fixture), port=a.port) as llm:
            print(llm.url)
            sys.stdout.flush()
            threading.Event().wait()
