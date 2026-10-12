"""The H3 Story Writer node: parsing, count checks and repairs, chunking, truncation handling, resume, the HTTP wire, the node.

No model, no ComfyUI, no torch: a scripted ``chat`` stands in for the model, and a local HTTP stub for the server.
"""

import contextlib
import json
import re
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import story_writer as sw  # noqa: E402


def outline_reply(n, *, cast=None, minor=False, extra_beats=0):
    beats = [f"Beat line {i}: Ana crosses the hall and says goodbye to the door number {i}." for i in range(1, n + 1 + extra_beats)]
    return json.dumps({"title": "T", "minor_in_sexual_content": minor, "cast": cast or [{"name": "Ana", "look": "a tall woman in a grey coat"}],
                       "locations": [{"name": "Hall", "look": "a long dim hall"}], "beats": [] if minor else beats})


def beat_text(i, words=30):
    return f"Ana walks through the hall number {i} and says, \"Door {i} is open.\" " + " ".join(["She waits."] * (words // 2))


def writer_reply(first, last, *, drop_last=0, end=True, number_offset=0):
    out = []
    for i in range(first, last + 1 - drop_last):
        out.append(f"=== {i + number_offset} ===\n{beat_text(i)}\n")
    if end:
        out.append("=== END ===")
    return "\n".join(out)


class Script:
    """A scripted chat: ``handler(kind, messages, call_no) -> str | Reply``; every call is recorded."""

    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __call__(self, messages, *, max_tokens, budget, kind="", temperature=0.6):
        self.calls.append({"kind": kind, "messages": messages, "max_tokens": max_tokens, "budget": budget})
        result = self.handler(kind, messages, len(self.calls))
        return result if isinstance(result, sw.Reply) else sw.Reply(result, "stop", 100, 200, 50, 0.1)

    def kinds(self):
        return [c["kind"] for c in self.calls]


def span(messages):
    m = re.search(r"WHAT TO WRITE: beats (\d+) to (\d+)", messages[0]["content"])
    return int(m.group(1)), int(m.group(2))


def good_handler(n):
    def handler(kind, messages, call_no):
        if kind == "outline":
            return outline_reply(n)
        first, last = span(messages)
        return writer_reply(first, last)
    return handler


def make_engine(chat, tmp, *, clips=8, **kw):
    return sw.StoryEngine(chat, Path(tmp) / "work", brief="A woman leaves a house.", clips=clips, **kw)


class ParsingTests(unittest.TestCase):
    def test_json_object_variants(self):
        self.assertEqual(sw.parse_json_object('{"a": 1}'), {"a": 1})
        self.assertEqual(sw.parse_json_object('```json\n{"a": [1, 2,]}\n```'), {"a": [1, 2]})
        self.assertEqual(sw.parse_json_object('Sure! Here it is: {"a": {"b": "}"}} hope that helps'), {"a": {"b": "}"}})
        self.assertEqual(sw.parse_json_object('<think>{"x":0}</think>{"a": 2}'), {"a": 2})
        self.assertIsNone(sw.parse_json_object("no json at all"))
        self.assertIsNone(sw.parse_json_object('{"a": '))

    def test_outline_coercion(self):
        out = sw.coerce_outline({"title": "x", "cast": [{"name": "Ana", "look": "tall"}, "Bo", {"look": "nameless"}], "beats": ["one  line", "", 3, "two"]})
        self.assertEqual(out["beats"], ["one line", "two"])
        self.assertEqual([c["name"] for c in out["cast"]], ["Ana", "Bo"])
        self.assertIsNone(sw.coerce_outline({"beats": []}))
        self.assertIsNone(sw.coerce_outline({"cast": []}))
        self.assertTrue(sw.coerce_outline({"minor_in_sexual_content": True, "beats": []})["minor"])

    def test_beats_are_cut_at_markers_and_cleaned(self):
        text = "=== 1 ===\n**Beat 1:** Ana opens the door.\nShe says, \"Hello there.\"\n\n=== 2 ===\n## Clip 2\n- Bo waves from the stairs with a very long sentence here.\n=== END ==="
        beats, saw_end = sw.parse_beats(text, 2, truncated=False)
        self.assertTrue(saw_end)
        self.assertEqual(beats[0], "Ana opens the door. She says, \"Hello there.\"")
        self.assertTrue(beats[1].startswith("Bo waves"))
        self.assertNotIn("\n", beats[0])
        self.assertNotIn("Clip", beats[1])

    def test_truncated_reply_loses_only_the_last_block(self):
        text = writer_reply(1, 4, end=False)
        beats, saw_end = sw.parse_beats(text, 4, truncated=True)
        self.assertFalse(saw_end)
        self.assertEqual(len(beats), 3)
        beats, _ = sw.parse_beats(text, 4, truncated=False)
        self.assertEqual(len(beats), 4)
        self.assertEqual(len(sw.parse_beats(writer_reply(1, 4), 4, truncated=True)[0]), 4)

    def test_extra_beats_ignored_and_short_block_stops_the_run(self):
        self.assertEqual(len(sw.parse_beats(writer_reply(1, 6), 3, truncated=False)[0]), 3)
        text = "=== 1 ===\n" + beat_text(1) + "\n=== 2 ===\nok\n=== 3 ===\n" + beat_text(3) + "\n=== END ==="
        self.assertEqual(len(sw.parse_beats(text, 3, truncated=False)[0]), 1)
        self.assertEqual(sw.parse_beats("just prose, no markers", 2, truncated=False), ([], False))

    def test_spoken_words(self):
        text = 'Ana says, "Come here now." Bo answers, “No way at all.” He doesn\'t move.'
        self.assertEqual(sw.quoted_words(text), 7)
        self.assertEqual(sw.quoted_lines(text), ["Come here now.", "No way at all."])

    def test_code_split(self):
        a, b = sw.code_split("Ana enters the hall. She finds the letter on the table. She reads it twice.")
        self.assertTrue(a.endswith(".") and b)
        self.assertEqual(len(sw.code_split("short")), 2)

    def test_sizes(self):
        self.assertTrue(sw.is_wide("Hindi"))
        self.assertFalse(sw.is_wide("english"))
        self.assertLess(sw.beat_words(15, "Hindi"), sw.beat_words(15, "English"))
        self.assertEqual(sw.max_speech_words(15), 30)
        self.assertEqual(sw.max_cast(6), 3)
        self.assertEqual(sw.max_cast(60), 8)
        self.assertAlmostEqual(sw.e4_weight("x" * 700), 1.0)
        self.assertAlmostEqual(sw.e4_weight("अ" * 380), 1.0)

    def test_output_room_follows_the_prompt(self):
        small = [{"role": "user", "content": "hi"}]
        big = [{"role": "user", "content": "word " * 20000}]
        self.assertGreater(sw.output_room(small, 65536), sw.output_room(big, 65536))
        self.assertGreaterEqual(sw.output_room(big, 16384), sw.MIN_OUTPUT)
        wide = [{"role": "user", "content": "अ" * 10000}]
        self.assertLess(sw.output_room(wide, 65536), sw.output_room([{"role": "user", "content": "a" * 10000}], 65536))


class OutlineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def engine(self, handler, clips=6):
        chat = Script(handler)
        return chat, make_engine(chat, self.tmp.name, clips=clips)

    def test_exact_count_is_one_call(self):
        chat, eng = self.engine(lambda k, m, n: outline_reply(6))
        out = eng.outline()
        self.assertEqual(len(out["beats"]), 6)
        self.assertEqual(chat.kinds(), ["outline"])
        self.assertEqual(out["cast"][0]["name"], "Ana")

    def test_wrong_count_one_retry_names_the_mismatch(self):
        def handler(kind, messages, n):
            return outline_reply(8) if kind == "outline" else outline_reply(6)
        chat, eng = self.engine(handler)
        out = eng.outline()
        self.assertEqual(len(out["beats"]), 6)
        self.assertEqual(chat.kinds(), ["outline", "outline_fix"])
        text = chat.calls[1]["messages"][0]["content"]
        self.assertIn("has 8 beats", text)
        self.assertIn("exactly 6", text)
        self.assertIn("2 too many", text)

    def test_too_many_after_retry_is_merged_in_code(self):
        chat, eng = self.engine(lambda k, m, n: outline_reply(9))
        out = eng.outline()
        self.assertEqual(len(out["beats"]), 6)
        self.assertEqual(chat.kinds(), ["outline", "outline_fix"])
        self.assertTrue(any("repaired in code" in w for w in eng.warnings))

    def test_too_few_after_retry_is_split_by_calls(self):
        def handler(kind, messages, n):
            if kind == "split_beat":
                return json.dumps({"beats": ["first half moment", "second half moment"]})
            return outline_reply(4)
        chat, eng = self.engine(handler)
        out = eng.outline()
        self.assertEqual(len(out["beats"]), 6)
        self.assertEqual(chat.kinds(), ["outline", "outline_fix", "split_beat", "split_beat"])

    def test_split_that_fails_falls_back_to_code(self):
        def handler(kind, messages, n):
            return "not json" if kind == "split_beat" else outline_reply(5)
        chat, eng = self.engine(handler)
        out = eng.outline()
        self.assertEqual(len(out["beats"]), 6)
        self.assertEqual(chat.kinds().count("split_beat"), 2)

    def test_unparseable_twice_then_two_parts(self):
        def handler(kind, messages, n):
            text = messages[0]["content"]
            if "FIRST PART" in text:
                return outline_reply(3)
            if "SECOND PART" in text:
                return outline_reply(3, cast=[{"name": "Bo", "look": "short"}])
            return "I cannot produce JSON"
        chat, eng = self.engine(handler)
        out = eng.outline()
        self.assertEqual(len(out["beats"]), 6)
        self.assertEqual({c["name"] for c in out["cast"]}, {"Ana", "Bo"})
        self.assertEqual(chat.kinds(), ["outline"] * 4)

    def test_cut_outline_is_retried_larger(self):
        def handler(kind, messages, n):
            return sw.Reply('{"beats": ["a", "b"', "length") if n == 1 else outline_reply(6)
        chat, eng = self.engine(handler)
        eng.outline()
        self.assertGreater(chat.calls[1]["max_tokens"], chat.calls[0]["max_tokens"])

    def test_nothing_usable_raises_and_keeps_replies(self):
        chat, eng = self.engine(lambda k, m, n: "nope", clips=2)
        with self.assertRaises(sw.StoryWriterError):
            eng.outline()
        self.assertTrue(list((Path(self.tmp.name) / "work" / "calls").glob("*.json")))

    def test_minor_flag_raises(self):
        chat, eng = self.engine(lambda k, m, n: outline_reply(6, minor=True))
        with self.assertRaises(sw.MinorContentError):
            eng.outline()

    def test_outline_is_stored_and_reused(self):
        chat, eng = self.engine(lambda k, m, n: outline_reply(6))
        eng.outline()
        again = make_engine(Script(lambda k, m, n: self.fail("no call expected")), self.tmp.name, clips=6)
        self.assertEqual(len(again.outline()["beats"]), 6)

    def test_prompt_carries_the_rules(self):
        chat, eng = self.engine(lambda k, m, n: outline_reply(6))
        eng.outline()
        text = chat.calls[0]["messages"][0]["content"]
        for needle in ("EXACTLY 6 beats", "about 15 seconds", "A lighthouse" if False else "A woman leaves a house.", "at most 3 named", "minor_in_sexual_content"):
            self.assertIn(needle, text)
        self.assertNotIn("{{", text)


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_chunks_of_eight_and_continuity(self):
        chat = Script(good_handler(20))
        eng = make_engine(chat, self.tmp.name, clips=20)
        result = eng.run()
        self.assertEqual(chat.kinds(), ["outline", "write", "write", "write"])
        self.assertEqual([span(c["messages"]) for c in chat.calls[1:]], [(1, 8), (9, 16), (17, 20)])
        paragraphs = result["story"].split("\n\n")
        self.assertEqual(len(paragraphs), 20)
        self.assertNotIn("===", result["story"])
        self.assertNotRegex(result["story"], r"(?i)\b(beat|clip) \d")
        second = chat.calls[2]["messages"][0]["content"]
        self.assertIn(beat_text(7).split("\"")[0], second)
        self.assertIn(beat_text(8).split("\"")[0], second)
        self.assertNotIn(beat_text(6).split("\"")[0] + "\"", second.split("THE LAST PARAGRAPHS")[1].split("WHAT TO WRITE")[0])
        first = chat.calls[1]["messages"][0]["content"]
        self.assertNotIn("THE LAST PARAGRAPHS", first)
        self.assertIn("<== WRITE THIS ONE", first)

    def test_every_call_carries_a_budget_and_room(self):
        chat = Script(good_handler(10))
        make_engine(chat, self.tmp.name, clips=10, budget=2048).run()
        for call in chat.calls:
            self.assertEqual(call["budget"], 2048)
            self.assertGreater(call["max_tokens"], call["budget"])
            self.assertLessEqual(call["max_tokens"], 65536)

    def test_truncated_reply_keeps_complete_beats_and_retries_the_rest(self):
        state = {"cut": False}

        def handler(kind, messages, n):
            if kind == "outline":
                return outline_reply(8)
            first, last = span(messages)
            if not state["cut"]:
                state["cut"] = True
                return sw.Reply(writer_reply(first, last, drop_last=4, end=False), "length")
            return writer_reply(first, last)
        chat = Script(handler)
        eng = make_engine(chat, self.tmp.name, clips=8)
        result = eng.run()
        self.assertEqual(len(result["beats"]), 8)
        self.assertEqual([span(c["messages"]) for c in chat.calls[1:]], [(1, 8), (4, 8)])
        self.assertGreater(chat.calls[2]["max_tokens"], chat.calls[1]["max_tokens"] - 1)
        self.assertIn("at most", chat.calls[2]["messages"][0]["content"])
        self.assertIn("keep their names", chat.calls[2]["messages"][0]["content"])

    def test_wrong_count_halves_the_chunk(self):
        def handler(kind, messages, n):
            if kind == "outline":
                return outline_reply(8)
            first, last = span(messages)
            if last - first + 1 > 4:
                return writer_reply(first, first)
            return writer_reply(first, last)
        chat = Script(handler)
        result = make_engine(chat, self.tmp.name, clips=8).run()
        self.assertEqual(len(result["beats"]), 8)
        self.assertIn("write", chat.kinds())

    def test_a_beat_that_never_comes_raises_and_resumes(self):
        def failing(kind, messages, n):
            if kind == "outline":
                return outline_reply(4)
            first, last = span(messages)
            if first >= 3:
                return "I could not do that"
            return writer_reply(first, min(last, 2))
        chat = Script(failing)
        eng = make_engine(chat, self.tmp.name, clips=4)
        with self.assertRaises(sw.StoryWriterError) as ctx:
            eng.run()
        self.assertIn("run again to resume", str(ctx.exception))
        kept = sorted(p.name for p in (Path(self.tmp.name) / "work" / "beats").glob("*.txt"))
        self.assertEqual(kept, ["001.txt", "002.txt"])
        resumed = Script(lambda k, m, n: self.fail("outline must be reused") if k == "outline" else writer_reply(*span(m)))
        result = make_engine(resumed, self.tmp.name, clips=4).run()
        self.assertEqual(len(result["beats"]), 4)
        self.assertEqual([span(c["messages"]) for c in resumed.calls], [(3, 4)])

    def test_minor_sentinel_in_a_chunk_raises(self):
        def handler(kind, messages, n):
            return outline_reply(3) if kind == "outline" else sw.SENTINEL_MINOR
        with self.assertRaises(sw.MinorContentError):
            make_engine(Script(handler), self.tmp.name, clips=3).run()

    def test_speech_over_the_limit_is_reported(self):
        def handler(kind, messages, n):
            if kind == "outline":
                return outline_reply(2)
            first, last = span(messages)
            talk = "=== 1 ===\nAna says, \"" + " ".join(["word"] * 60) + "\" and leaves the hall slowly.\n=== 2 ===\n" + beat_text(2) + "\n=== END ==="
            return talk
        eng = make_engine(Script(handler), self.tmp.name, clips=2)
        eng.run()
        self.assertTrue(any("beat 1" in w and "spoken words" in w for w in eng.warnings))

    def test_hindi_prompt_asks_for_native_script(self):
        chat = Script(good_handler(2))
        sw.StoryEngine(chat, Path(self.tmp.name) / "hi", brief="b", clips=2, language="Hindi").run()
        self.assertIn("own native script", chat.calls[0]["messages"][0]["content"])
        self.assertIn("Hindi", chat.calls[1]["messages"][0]["content"])


class WriteStoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_files_and_sidecar(self):
        result = sw.write_story(Script(good_handler(6)), brief="A woman leaves a house.", clips=6, out_dir=self.tmp.name, model="m", style="ninfer-messages", seed=7)
        story = Path(result["story_path"])
        self.assertTrue(story.name.endswith("_6clips.md"))
        self.assertEqual(story.read_text(encoding="utf-8").strip(), result["story"])
        side = json.loads(Path(result["json_path"]).read_text(encoding="utf-8"))
        for key in ("brief_sha1", "clips_requested", "beats_written", "model", "tokens", "stop_reasons", "e4_estimated_clips", "warnings", "call_log", "wall_seconds"):
            self.assertIn(key, side)
        self.assertEqual((side["clips_requested"], side["beats_written"], side["model"], side["seed"]), (6, 6, "m", 7))
        self.assertEqual(side["tokens"]["thinking"], 50 * side["calls"])
        self.assertEqual(side["stop_reasons"], {"stop": side["calls"]})

    def test_inputs_are_checked(self):
        for bad in (dict(brief="  ", clips=3), dict(brief="x", clips=0), dict(brief="x", clips=61)):
            with self.assertRaises(sw.StoryWriterError):
                sw.write_story(Script(good_handler(3)), out_dir=self.tmp.name, **bad)

    def test_sixty_clips(self):
        chat = Script(good_handler(60))
        result = sw.write_story(chat, brief="b", clips=60, out_dir=self.tmp.name)
        self.assertEqual(len(result["story"].split("\n\n")), 60)
        self.assertEqual(chat.kinds(), ["outline"] + ["write"] * 8)

    def test_a_new_seed_is_a_new_run(self):
        a = sw.job_hash("b", 6, 15, "English", 1, "m", 4096)
        self.assertNotEqual(a, sw.job_hash("b", 6, 15, "English", 2, "m", 4096))
        self.assertNotEqual(a, sw.job_hash("b", 7, 15, "English", 1, "m", 4096))
        self.assertEqual(a, sw.job_hash(" b ", 6, 15, "English", 1, "m", 4096))


class Stub(BaseHTTPRequestHandler):
    seen = []
    mode = "ok"

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Stub.seen.append((self.path, body))
        if Stub.mode == "400":
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error": "context"}')
            return
        text = Stub.reply(body)
        if self.path == "/v1/messages":
            payload = {"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": text}], "stop_reason": "end_turn",
                       "usage": {"input_tokens": 11, "output_tokens": 22, "output_tokens_details": {"thinking_tokens": 5}}}
        else:
            payload = {"choices": [{"message": {"content": "<think>x</think>" + text}, "finish_reason": "length"}],
                       "usage": {"prompt_tokens": 11, "completion_tokens": 22, "completion_tokens_details": {"reasoning_tokens": 5}}}
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass

    @staticmethod
    def reply(body):
        content = body["messages"][0]["content"]
        if "shooting outline" in content:
            return outline_reply(3)
        return writer_reply(*span(body["messages"]))


@contextlib.contextmanager
def stub_server(mode="ok"):
    Stub.seen, Stub.mode = [], mode
    server = HTTPServer(("127.0.0.1", 0), Stub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


class WireTests(unittest.TestCase):
    def test_ninfer_messages_request_and_reply(self):
        with stub_server() as url:
            chat = sw.ServerChat({"url": url, "model": "m", "style": "ninfer-messages"})
            reply = chat([{"role": "system", "content": "S"}, {"role": "user", "content": "shooting outline"}], max_tokens=9000, budget=4096, kind="outline")
        path, body = Stub.seen[0]
        self.assertEqual(path, "/v1/messages")
        self.assertEqual(body["thinking"], {"type": "enabled", "budget_tokens": 4096})
        self.assertEqual((body["max_tokens"], body["system"], body["model"]), (9000, "S", "m"))
        self.assertEqual([m["role"] for m in body["messages"]], ["user"])
        self.assertEqual((reply.finish, reply.prompt_tokens, reply.completion_tokens, reply.thinking_tokens), ("stop", 11, 22, 5))
        self.assertIn("beats", reply.text)

    def test_llama_chat_request_and_reply(self):
        with stub_server() as url:
            chat = sw.ServerChat({"url": url, "model": "m", "style": "llama-chat"})
            reply = chat([{"role": "user", "content": "shooting outline"}], max_tokens=9000, budget=2048, kind="outline")
        path, body = Stub.seen[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(body["reasoning_budget_tokens"], 2048)
        self.assertEqual(body["reasoning_budget_message"], sw.BUDGET_MESSAGE)
        self.assertNotIn("thinking", body)
        self.assertEqual(reply.finish, "length")
        self.assertFalse(reply.text.startswith("<think>"))

    def test_unreachable_server_raises_after_retries(self):
        slept = []
        chat = sw.ServerChat({"url": "http://127.0.0.1:9", "model": "m", "style": "ninfer-messages"}, sleep=slept.append, timeout=2)
        with self.assertRaises(sw.LLMUnavailable) as ctx:
            chat([{"role": "user", "content": "x"}], max_tokens=5000, budget=1024, kind="outline")
        self.assertIn("nothing was written", str(ctx.exception))
        self.assertEqual(slept, [4, 8])

    def test_refused_request_is_not_retried(self):
        with stub_server("400") as url:
            chat = sw.ServerChat({"url": url, "model": "m", "style": "ninfer-messages"}, sleep=lambda s: self.fail("no retry"))
            with self.assertRaises(sw.StoryWriterError) as ctx:
                chat([{"role": "user", "content": "x"}], max_tokens=5000, budget=1024, kind="write")
        self.assertNotIsInstance(ctx.exception, sw.LLMUnavailable)
        self.assertEqual(len(Stub.seen), 1)

    def test_interrupt_is_honoured(self):
        with stub_server() as url:
            chat = sw.ServerChat({"url": url, "model": "m", "style": "ninfer-messages"}, interrupted=lambda: True)
            with self.assertRaises(KeyboardInterrupt):
                chat([{"role": "user", "content": "x"}], max_tokens=5000, budget=1024)
        self.assertEqual(Stub.seen, [])

    def test_engine_over_http(self):
        with stub_server() as url, tempfile.TemporaryDirectory() as tmp:
            chat = sw.ServerChat({"url": url, "model": "m", "style": "ninfer-messages"})
            result = sw.write_story(chat, brief="b", clips=3, out_dir=tmp)
        self.assertEqual(len(result["story"].split("\n\n")), 3)


class NodeTests(unittest.TestCase):
    def test_registered_beside_the_extender_node(self):
        self.assertIn("H3StoryWriter", sw.NODE_CLASS_MAPPINGS)
        self.assertIn("H3StoryWriter", sw.NODE_DISPLAY_NAME_MAPPINGS)
        spec = sw.H3StoryWriter.INPUT_TYPES()["required"]
        self.assertEqual(list(spec), ["brief", "clips", "seconds", "language", "seed", "writer_model", "thinking_budget"])
        self.assertEqual((spec["clips"][1]["default"], spec["clips"][1]["min"], spec["clips"][1]["max"]), (8, 1, 60))
        self.assertEqual(sw.H3StoryWriter.RETURN_TYPES, ("STRING",))
        self.assertEqual(sw.H3StoryWriter.RETURN_NAMES, ("story",))
        init = (ROOT / "__init__.py").read_text(encoding="utf-8")
        self.assertIn("STORY_WRITER_NODE_CLASS_MAPPINGS", init)

    def test_write_runs_the_engine_and_returns_the_story(self):
        with stub_server() as url, tempfile.TemporaryDirectory() as tmp:
            @contextlib.contextmanager
            def fake_open(label, budget, slot_ctx, say):
                yield {"url": url, "model": "m", "style": "ninfer-messages"}, mock.Mock(interrupted=lambda: False)

            with mock.patch.object(sw, "open_model", fake_open), mock.patch.object(sw, "output_root", lambda base=None: Path(tmp) / "out"):
                (story,) = sw.H3StoryWriter().write("a brief", 3, 15, "English", 1, "w", 4096)
            self.assertEqual(len(story.split("\n\n")), 3)
            self.assertEqual(len(list((Path(tmp) / "out").glob("*_3clips.md"))), 1)
            self.assertEqual(len(list((Path(tmp) / "out").glob("*_3clips.json"))), 1)

    def test_server_is_closed_and_vram_released(self):
        closed = []

        @contextlib.contextmanager
        def session(*args, **kwargs):
            self.assertTrue(kwargs["force"])
            self.assertEqual(kwargs["slots"], 1)
            self.assertEqual(kwargs["reasoning"], {"enabled": True, "budget": 4096, "message": sw.BUDGET_MESSAGE})
            try:
                yield mock.Mock(base="http://127.0.0.1:1", model_id="mid")
            finally:
                closed.append(True)

        pack = (mock.Mock(), mock.Mock(), mock.Mock(session=session), mock.Mock(is_ninfer=lambda p: True), mock.Mock())
        with mock.patch.object(sw, "_pack", lambda: pack), mock.patch.object(sw.prompt_rewriter, "_vision_files", lambda n, p, l: ("w.ninfer", "")), \
                mock.patch.object(sw.vram_release, "release") as release:
            with self.assertRaises(RuntimeError):
                with sw.open_model("writer", 4096, slot_ctx=65536) as (endpoint, runner):
                    self.assertEqual((endpoint["style"], endpoint["model"]), ("ninfer-messages", "mid"))
                    raise RuntimeError("boom")
        self.assertEqual(closed, [True])
        release.assert_called_once()

    def test_writer_without_a_server_is_refused(self):
        pack = (mock.Mock(), mock.Mock(), mock.Mock(), mock.Mock(), mock.Mock())
        with mock.patch.object(sw, "_pack", lambda: pack), mock.patch.object(sw.prompt_rewriter, "_vision_files", lambda n, p, l: ("", "")):
            with self.assertRaises(sw.StoryWriterError) as ctx:
                with sw.open_model("plain gguf", 4096, slot_ctx=65536):
                    pass
        self.assertIn("runs on a server", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
