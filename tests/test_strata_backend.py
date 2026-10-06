import contextlib
import json
import os
import sys
import tempfile
import threading
import types
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import prompt_rewriter as pr  # noqa: E402
import strata_backend as sb  # noqa: E402


class FakeStrata:
    """A loopback server with the four routes of Strata that the extender uses."""

    def __init__(self, busy_first=0):
        self.requests = []
        self.busy = busy_first
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, code, payload, kind="application/json"):
                data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                owner.requests.append(("GET", self.path, None))
                self._reply(200, {"status": "ok"}) if self.path == "/health" else self._reply(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                owner.requests.append(("POST", self.path, body))
                if self.path == "/v1/unload":
                    return self._reply(200, {"status": "unloaded"})
                if owner.busy > 0:
                    owner.busy -= 1
                    return self._reply(503, {"error": {"message": "the engine is starting (a minute or two); try again shortly"}})
                frames = [{"choices": [{"delta": {"reasoning_content": "hmm "}}]},
                          {"choices": [{"delta": {"reasoning_content": "ok"}}]},
                          {"choices": [{"delta": {"content": "shot_1: "}}]},
                          {"choices": [{"delta": {"content": "a door."}}]}]
                text = "".join(f"data: {json.dumps(f)}\n\n" for f in frames) + "data: [DONE]\n\n"
                self._reply(200, text.encode(), "text/event-stream")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def posts(self, path):
        return [body for method, p, body in self.requests if method == "POST" and p == path]


MSGS = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "go"}]


class BodyTests(unittest.TestCase):
    def test_body_carries_budget_model_and_thinking_flag(self):
        body = sb.request_body(MSGS, seed=7, greedy=True, max_new_tokens=8192, thinking=True, budget=4096)
        self.assertEqual(body, {
            "model": "qwen3.8-flash-next-iq3_s", "messages": MSGS, "max_tokens": 8192, "seed": 7, "stream": True,
            "reasoning_budget_tokens": 4096, "chat_template_kwargs": {"enable_thinking": True}, "temperature": 0.0})

    def test_budget_is_never_zero_or_unlimited(self):
        for bad in (0, -1):
            body = sb.request_body(MSGS, seed=1, greedy=True, max_new_tokens=10, thinking=False, budget=bad)
            self.assertEqual(body["reasoning_budget_tokens"], sb.DEFAULT_BUDGET)
            self.assertEqual(body["chat_template_kwargs"], {"enable_thinking": False})

    def test_sampling_and_no_repeat_penalty(self):
        body = sb.request_body(MSGS, seed=1, greedy=False, max_new_tokens=10, temperature=0.6, top_p=0.8, top_k=20,
                               thinking=False, budget=4096)
        self.assertEqual((body["temperature"], body["top_p"], body["top_k"]), (0.6, 0.8, 20))
        self.assertNotIn("repeat_penalty", body)


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeStrata()
        self.addCleanup(self.fake.close)

    def test_chat_posts_to_the_endpoint_and_streams_both_channels(self):
        server = sb.StrataServer(self.fake.url, budget=4096)
        thoughts, answers = [], []
        text = server.chat(MSGS, seed=42, greedy=True, max_new_tokens=100 + 4096, repeat_penalty=1.05,
                           enable_thinking=True, on_text=lambda t: answers.append(t) and False,
                           on_reasoning=thoughts.append)
        self.assertEqual(text, "shot_1: a door.")
        self.assertEqual(thoughts[-1], "hmm ok")
        sent = self.fake.posts("/v1/chat/completions")[0]
        self.assertEqual(sent["model"], "qwen3.8-flash-next-iq3_s")
        self.assertEqual(sent["max_tokens"], 4196)
        self.assertEqual(sent["reasoning_budget_tokens"], 4096)
        self.assertEqual(sent["chat_template_kwargs"], {"enable_thinking": True})
        self.assertNotIn("repeat_penalty", sent)
        self.assertTrue(sent["stream"])

    def test_a_503_starting_is_retried(self):
        fake = FakeStrata(busy_first=2)
        self.addCleanup(fake.close)
        saved = sb.RETRY_SECONDS
        sb.RETRY_SECONDS = 0.01
        self.addCleanup(setattr, sb, "RETRY_SECONDS", saved)
        text = sb.StrataServer(fake.url).chat(MSGS, enable_thinking=False)
        self.assertEqual(text, "shot_1: a door.")
        self.assertEqual(len(fake.posts("/v1/chat/completions")), 3)


class OpenTests(unittest.TestCase):
    def setUp(self):
        self.spawned = []
        self.env = {k: os.environ.pop(k, None) for k in (sb.URL_ENV, sb.GATEWAY_CONFIG_ENV)}
        self.addCleanup(self.restore)

        def no_spawn(spec, adopt=None):
            self.spawned.append(spec)
            raise AssertionError("attach mode must not start a process")

        self.patched = {name: getattr(sb, name) for name in ("_spawn", "DEFAULT_URL", "_stop", "free_comfy_vram", "_free_port")}
        sb._spawn = no_spawn
        sb.free_comfy_vram = lambda: None
        self.addCleanup(self.unpatch)

    def restore(self):
        for key, value in self.env.items():
            os.environ.pop(key, None)
            if value is not None:
                os.environ[key] = value

    def unpatch(self):
        for name, value in self.patched.items():
            setattr(sb, name, value)

    def test_attach_does_not_spawn_unloads_and_never_kills(self):
        fake = FakeStrata()
        self.addCleanup(fake.close)
        sb.DEFAULT_URL = fake.url
        killed = []
        sb._stop = killed.append
        with sb.open_strata(4096) as server:
            self.assertEqual(server.base, fake.url)
            self.assertIsNone(server.process)
            self.assertEqual(server.chat(MSGS, enable_thinking=False), "shot_1: a door.")
        self.assertEqual(self.spawned, [])
        self.assertEqual(killed, [])
        self.assertEqual(len(fake.posts("/v1/unload")), 1)
        self.assertTrue(sb._healthy(fake.url))

    def test_explicit_url_that_is_down_raises_and_never_spawns(self):
        os.environ[sb.URL_ENV] = "http://127.0.0.1:9"
        with self.assertRaises(sb.StrataUnavailable):
            with sb.open_strata(4096):
                pass
        self.assertEqual(self.spawned, [])

    def test_down_without_gateway_config_raises_clearly(self):
        sb.DEFAULT_URL = "http://127.0.0.1:9"
        os.environ[sb.GATEWAY_CONFIG_ENV] = os.path.join(tempfile.gettempdir(), "no-such-backends.json")
        with self.assertRaises(sb.StrataUnavailable) as caught:
            with sb.open_strata(4096):
                pass
        self.assertIn("no GPU gateway config", str(caught.exception))

    def test_down_starts_gateway_command_on_private_port_and_kills_it(self):
        sb.DEFAULT_URL = "http://127.0.0.1:9"
        lane = {"cmd": ["python", "server.py", "--engine", "strata", "--port", "8095", "--host", "127.0.0.1"],
                "cwd": "C:\\Strata", "env": {"A": "1"}}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump({"backends": {"strata": lane}}, handle)
        self.addCleanup(os.unlink, handle.name)
        os.environ[sb.GATEWAY_CONFIG_ENV] = handle.name

        fake = FakeStrata()
        self.addCleanup(fake.close)
        fake_port = fake.url.rsplit(":", 1)[1]
        sb._free_port = lambda: int(fake_port)
        proc = types.SimpleNamespace(poll=lambda: None, returncode=None, pid=1)
        started, killed = [], []
        sb._spawn = lambda spec, adopt=None: started.append(spec) or proc
        sb._stop = killed.append

        with sb.open_strata(4096) as server:
            self.assertEqual(server.base, fake.url)
            self.assertIs(server.process, proc)
        cmd = started[0]["cmd"]
        self.assertEqual(cmd[cmd.index("--port") + 1], fake_port)
        self.assertEqual(started[0]["cwd"], "C:\\Strata")
        self.assertEqual(killed, [proc])
        self.assertEqual(fake.posts("/v1/unload"), [])


class DropdownTests(unittest.TestCase):
    def test_strata_is_appended_last_and_pack_default_stays_first(self):
        saved = pr._mod
        pr._mod = lambda name: types.SimpleNamespace(writer_choices=lambda: ["Swift 1.5 (NInfer)", "Other"])
        try:
            self.assertEqual(pr.writer_choices(), ["Swift 1.5 (NInfer)", "Other", sb.LABEL])
        finally:
            pr._mod = saved

    def test_without_the_pack_the_dropdown_is_the_install_hint(self):
        saved = pr._mod

        def boom(name):
            raise RuntimeError("missing")

        pr._mod = boom
        try:
            self.assertEqual(pr.writer_choices(), [pr.MISSING])
        finally:
            pr._mod = saved


class RewriteWithStrataTests(unittest.TestCase):
    def run_rewrite(self, thinking, budget, max_new=100):
        events, chats = [], []

        class Server:
            def chat(self, messages, **kw):
                chats.append(kw)
                events.append("chat")
                return "FINAL"

        @contextlib.contextmanager
        def session(*a, **kw):
            self.session_kw = kw
            events.append("session open")
            try:
                yield None
            finally:
                events.append("session closed")

        @contextlib.contextmanager
        def open_strata(budget_, adopt=None, on_wait=None):
            self.opened_budget = budget_
            events.append("strata open")
            try:
                yield Server()
            finally:
                events.append("strata closed")

        def build(guide, task, prompt, resolution, duration, refs, system=""):
            return [{"role": "system", "content": "SYS"}, {"role": "user", "content": f"original_prompt: {prompt}"}]

        mods = {
            "nodes": types.SimpleNamespace(DEFAULT_OPTIONS={}, caption_question=lambda *a: "?"),
            "paths": types.SimpleNamespace(),
            "guides": types.SimpleNamespace(text=lambda *a: "GUIDE"),
            "guide_prompt": types.SimpleNamespace(GUIDE_FOR_MODE={"T2VA": 1}, FIELDS_FOR_MODE={"T2VA": ["a"]},
                                                  build_messages=build, context_needed=lambda m, b: 4096),
            "fields": types.SimpleNamespace(split_fields=lambda t, n: {"a": t}, missing=lambda s, n: []),
            "checks": types.SimpleNamespace(looping=lambda t: False),
            "mtmd_engine": types.SimpleNamespace(session=session),
            "aspect": types.SimpleNamespace(resolve=lambda a, d: "16:9"),
            "constants": types.SimpleNamespace(answer_only=lambda t: t),
            "runner": types.SimpleNamespace(_adopt=lambda p: None),
        }
        saved = (pr._mod, pr.available, pr._load_cache, sb.open_strata)
        pr._mod = lambda name: mods[name]
        pr.available = lambda: True
        pr._load_cache = lambda: {}
        sb.open_strata = open_strata
        try:
            clips = [{"id": "1", "prompt": "ask", "duration": 10}]
            settings = {"rewrite_mode": "pending clips", "rewrite_writer_model": sb.LABEL,
                        "rewrite_task": "T2VA", "rewrite_parallel": 3, "rewrite_max_new_tokens": max_new,
                        "rewrite_thinking": thinking, "rewrite_reasoning_budget": budget}
            pr.rewrite_clips(clips, {}, settings, aspect_text="1280x720")
        finally:
            pr._mod, pr.available, pr._load_cache, sb.open_strata = saved
        return clips, events, chats

    def test_writer_runs_on_strata_with_budget_on_top_of_the_answer(self):
        clips, events, chats = self.run_rewrite(True, 4096)
        self.assertEqual(chats[0]["max_new_tokens"], 100 + 4096)
        self.assertTrue(chats[0]["enable_thinking"])
        self.assertEqual(self.opened_budget, 4096)
        self.assertEqual(clips[0]["prompt"], "FINAL")
        self.assertEqual(events, ["strata open", "chat", "strata closed"])

    def test_thinking_off_gives_no_thinking_and_no_extra_tokens(self):
        _, _, chats = self.run_rewrite(False, 4096)
        self.assertEqual(chats[0]["max_new_tokens"], 100)
        self.assertFalse(chats[0]["enable_thinking"])

    def test_unrestricted_budget_becomes_the_default_budget(self):
        _, _, chats = self.run_rewrite(True, -1)
        self.assertEqual(self.opened_budget, sb.DEFAULT_BUDGET)
        self.assertEqual(chats[0]["max_new_tokens"], 100 + sb.DEFAULT_BUDGET)


if __name__ == "__main__":
    unittest.main()
