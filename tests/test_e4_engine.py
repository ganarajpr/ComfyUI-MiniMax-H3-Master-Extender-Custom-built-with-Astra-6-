"""story_engine=e4: the E4.6 engine inside the Master Extender's story mode.

  - EngineTests: ``rewrite_clips`` with story_engine=e4 runs the vendored E4 as a real Node subprocess against a mock model server that REPLAYS a
    stored real run (tests/fixtures/e4_replay.json.gz). Proves: valid clips in the extender's clip structure, the pictures bound and cited with the
    extender's own Picture numbers, integer durations, the builder not run, both wires (ninfer /v1/messages, llama.cpp chat), the logs, the progress.
  - BuilderUnchanged: story_engine absent or "builder" makes exactly the requests the base commit b12b03d made (tests/fixtures/builder_story_b12b03d.json).
  - FrozenCopy: e4/verify-frozen.mjs passes, and fails when a frozen file, a patch or the file list is touched.
  - Unit tests of the Python side (notes, endpoint, budgets, applying clips, node discovery).
No torch, no ComfyUI: they need Node 18+, numpy and Pillow, and skip otherwise.
"""

import copy
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import e4_engine  # noqa: E402
import e4_mock_llm  # noqa: E402
import builder_scenario  # noqa: E402
import stub_pack  # noqa: E402

try:
    import numpy  # noqa: F401
    import PIL  # noqa: F401
    HAVE_IMAGING = True
except ImportError:
    HAVE_IMAGING = False

NODE = os.environ.get(e4_engine.NODE_ENV) or shutil.which("node")
FIXTURES = ROOT / "tests" / "fixtures"
REPLAY = FIXTURES / "e4_replay.json.gz"
META = json.loads((FIXTURES / "e4_replay_meta.json").read_text(encoding="utf-8")) if (FIXTURES / "e4_replay_meta.json").is_file() else None
needs_node = unittest.skipUnless(NODE and e4_engine.node_version(NODE)[0] >= e4_engine.MIN_NODE_MAJOR, "needs Node.js 18+")
needs_imaging = unittest.skipUnless(HAVE_IMAGING, "needs numpy and Pillow")
needs_replay = unittest.skipUnless(REPLAY.is_file() and META, "tests/fixtures/e4_replay* not present")

SIX = ["subject_definitions", "summary", "retention_analysis", "detailed_description", "overall_soundscape", "non_diegetic_music"]


def default_mapping(text):
    """A model that binds the entities of the list, in order, to the pictures, in order (only used when the replay has no recording of the call)."""
    ids = re.findall(r"^- (\w+) \|", text, re.M)
    line = [x for x in text.splitlines() if x.startswith("Answer for EVERY picture:")][0]
    labels = [int(x) for x in re.findall(r"Picture (\d+)", line)]
    return json.dumps({"pictures": [{"picture": n, "entity": ids[i] if i < len(ids) else "unused", "shows": "stub"} for i, n in enumerate(labels)]})


def settings_for(story, **extra):
    s = dict(builder_scenario.BASE, rewrite_story=story, auto_clips=2, rewrite_parallel=2, story_engine="e4", e4_language="English", e4_score=(META or {}).get("score", "off"),
             e4_decision_budget="2048", e4_picture_notes="", rewrite_thinking=False)
    s.update(extra)
    return s


def sections_of(prompt):
    out, current = {}, None
    for line in prompt.split("\n"):
        m = re.fullmatch(r"(" + "|".join(SIX) + r"):", line)
        if m:
            current = m.group(1)
            out[current] = []
        elif current:
            out[current].append(line)
    return {k: "\n".join(v).strip() for k, v in out.items()}


@needs_node
@needs_imaging
@needs_replay
class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.story = (FIXTURES / "e4_story.txt").read_text(encoding="utf-8").strip()
        cls.labels = META["labels"]
        cls.user = Path(tempfile.mkdtemp())
        cls.runs = {}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.user, ignore_errors=True)

    def run_engine(self, key, *, suffix=".ninfer", settings=None, clips=None, vision=True):
        if key in self.runs:
            return self.runs[key]
        user = Path(tempfile.mkdtemp(dir=self.user))
        with e4_mock_llm.MockLLM(REPLAY, mapping=default_mapping) as llm:
            refs = stub_pack.make_pictures([n - 1 for n in self.labels])
            rec, notes, clips = stub_pack.run_rewrite(
                ROOT, settings or settings_for(self.story), clips if clips is not None else builder_scenario.clips_empty(1), refs=refs, writer_suffix=suffix,
                server_base=llm.url, model_id="mock-model", user_dir=user, vision=vision)
        self.runs[key] = Ns(rec=rec, notes=notes, clips=clips, llm=llm, user=user)
        return self.runs[key]

    # ---- the clips
    def test_clips_are_valid_extender_clips(self):
        run = self.run_engine("ninfer")
        self.assertEqual([], run.llm.misses, "every request E4 made must be one the stored run made")
        clips = run.clips
        self.assertEqual(META["clips"], len(clips))
        for i, clip in enumerate(clips):
            self.assertIsInstance(clip["id"], int)
            self.assertIs(type(clip["duration"]), int)
            self.assertEqual(15, clip["duration"], "E4's 15.08 s is the whole second 15")
            self.assertTrue(clip["prompt_rewritten"] and clip["planned"])
            self.assertFalse(clip["validated"])
            self.assertEqual(clip["prompt"], clip["rewrite_text"])
            self.assertTrue(clip["prompt_raw"].strip(), "the planned ask stays as the raw ask")
            self.assertTrue(clip["title"].startswith(f"Clip {i + 1}: "))
            self.assertIsInstance(clip["plan_end_state"], dict)
            meta = clip["rewrite_meta"]
            self.assertEqual("e4", meta["engine"])
            self.assertEqual("Ref2VA", meta["task"])
            self.assertTrue(str(meta["fingerprint"]).startswith("v2:"), "the fingerprint is the extender's, so the clip is not stale")
            self.assertEqual(SIX, list(sections_of(clip["prompt"])))
            music = sections_of(clip["prompt"])["non_diegetic_music"]
            if META.get("score", "off") == "off":
                self.assertEqual("N/A", music)
            else:
                self.assertNotEqual("N/A", music, "score on: the bible's score is every clip's non_diegetic_music")
        self.assertEqual([list(range(len(clips)))], run.rec.plans)
        self.assertEqual(len(clips), len([s for s in run.rec.streams if s[2] == "done"]))

    def test_the_builder_does_not_run(self):
        run = self.run_engine("ninfer")
        self.assertEqual([], run.rec.chats, "no planner.md or builder.md call goes through the extender's own server session")
        # and nothing is pending: the clips are not rewritten again
        pending = e4_pending(run.clips)
        self.assertEqual([], pending)

    def test_server_session_is_sized_for_e4(self):
        run = self.run_engine("ninfer")
        kw = run.rec.sessions[0]["kw"]
        self.assertTrue(kw["reasoning"]["enabled"])
        self.assertEqual(4096, kw["reasoning"]["budget"])
        self.assertGreaterEqual(kw["pool_ctx"], e4_engine.slot_ctx() * kw["slots"])
        self.assertGreaterEqual(kw["slots"], 2)

    # ---- the pictures
    def test_pictures_are_bound_and_cited_in_the_extenders_numbers(self):
        run = self.run_engine("ninfer")
        labels = set(self.labels)
        mapping = json.loads(next(run.user.rglob("map.json")).read_text(encoding="utf-8"))
        owner = {p["picture"]: p["entity"] for p in mapping["pictures"] if p["entity"]}
        self.assertEqual(META["mapping"], {str(k): v for k, v in owner.items()}, "the stored model reply binds these pictures")
        seen = set()
        for clip in run.clips:
            sections = sections_of(clip["prompt"])
            paras = sections["subject_definitions"].split("\n\n")
            cited = {}
            for k, para in enumerate(paras, start=1):
                m = re.match(rf"<Subject {k}> is (.+?) in <Picture (\d+)>", para)
                if m:
                    cited[int(m.group(2))] = k
                else:
                    self.assertNotIn("<Picture", para, "a subject with no picture cites none")
            self.assertTrue(set(cited) <= labels, f"cited {sorted(cited)} of the attached {sorted(labels)}")
            self.assertEqual(sorted(cited), sorted(p["picture"] for p in clip["rewrite_meta"]["pictures"]))
            for p in clip["rewrite_meta"]["pictures"]:
                self.assertEqual(owner[p["picture"]], p["entity"])
            for name in SIX[1:]:
                self.assertNotIn("<Picture", sections[name], f"{name} must not cite a picture")
            self.assertEqual([], clip["rewrite_meta"]["citation_issues"])
            seen |= set(cited)
        self.assertTrue(seen, "at least one picture is cited")

    def test_the_model_saw_every_picture_in_the_binding_call(self):
        run = self.run_engine("ninfer")
        calls = [r for r in run.llm.requests if "binding the reference pictures" in json.dumps(r["body"]["messages"])]
        self.assertTrue(calls)
        content = calls[0]["body"]["messages"][0]["content"]
        images = [p for p in content if p["type"] == "image"]
        self.assertEqual(len(self.labels), len(images))
        texts = [p["text"] for p in content if p["type"] == "text"]
        for n in self.labels:
            self.assertIn(f"Picture {n}:", texts, "each picture is labelled right before its image")
        self.assertEqual("base64", images[0]["source"]["type"])

    # ---- the wires and the budgets
    def test_ninfer_wire_carries_per_request_budgets(self):
        run = self.run_engine("ninfer")
        self.assertTrue(run.llm.requests)
        self.assertEqual({"messages"}, {r["wire"] for r in run.llm.requests})
        budgets = {}
        for r in run.llm.requests:
            text = json.dumps(r["body"]["messages"])
            kind = "map" if "binding the reference pictures" in text else "decision" if "ref." in text and "on screen at any point" in text else "plan" if "RUNTIME" in text else "other"
            budgets.setdefault(kind, set()).add(r["body"]["thinking"]["budget_tokens"])
            self.assertEqual("enabled", r["body"]["thinking"]["type"])
            self.assertLessEqual(r["body"]["max_tokens"], e4_engine.max_tokens())
        self.assertEqual({2048}, budgets["decision"])
        self.assertEqual({2048}, budgets["map"])
        self.assertEqual({4096}, budgets["plan"])
        self.assertEqual({4096}, budgets["other"], "bible, writer and repairs think 4096 at most")

    def test_llama_wire_carries_top_level_budget_fields(self):
        run = self.run_engine("llama", suffix=".gguf")
        self.assertEqual([], run.llm.misses)
        self.assertEqual({"chat"}, {r["wire"] for r in run.llm.requests})
        for r in run.llm.requests:
            self.assertIn("reasoning_budget_tokens", r["body"])
            self.assertEqual("Time to stop thinking. Give the final answer now.", r["body"]["reasoning_budget_message"])
            self.assertNotIn("chat_template_kwargs", r["body"])
            self.assertNotIn("thinking", r["body"])
        ninfer = self.run_engine("ninfer")
        self.assertEqual([c["prompt"] for c in ninfer.clips], [c["prompt"] for c in run.clips], "the wire changes nothing about the prompts")
        content = [r for r in run.llm.requests if "binding the reference pictures" in json.dumps(r["body"]["messages"])][0]["body"]["messages"][0]["content"]
        self.assertEqual(len(self.labels), len([p for p in content if p["type"] == "image_url"]))

    def test_pictures_fall_back_to_the_chat_wire_when_messages_refuses_them(self):
        user = Path(tempfile.mkdtemp(dir=self.user))
        with e4_mock_llm.MockLLM(REPLAY, mapping=default_mapping, refuse_images_on_messages=True) as llm:
            rec, notes, clips = stub_pack.run_rewrite(ROOT, settings_for(self.story), builder_scenario.clips_empty(1), refs=stub_pack.make_pictures([n - 1 for n in self.labels]),
                                                      writer_suffix=".ninfer", server_base=llm.url, user_dir=user)
        self.assertEqual([], llm.misses)
        refused = [r for r in llm.requests if r["key"] == "refused-images"]
        self.assertEqual(3, len(refused), "the messages wire was tried (with its three transport retries) before the fallback")
        chat = [r for r in llm.requests if r["wire"] == "chat" and "binding the reference pictures" in json.dumps(r["body"]["messages"])]
        self.assertEqual(1, len(chat))
        self.assertEqual(len(self.labels), len([p for p in chat[0]["body"]["messages"][0]["content"] if p["type"] == "image_url"]))
        mapping = json.loads(next(user.rglob("map.json")).read_text(encoding="utf-8"))
        self.assertIn("/v1/chat/completions", mapping["fallbackWire"])
        self.assertTrue(all(c["prompt_rewritten"] for c in clips))
        self.assertTrue(any("pictures" in c["rewrite_meta"] and c["rewrite_meta"]["pictures"] for c in clips))

    # ---- logs and progress
    def test_every_request_and_reply_is_logged(self):
        run = self.run_engine("ninfer")
        calls = next(run.user.rglob("calls.jsonl"))
        rows = [json.loads(line) for line in calls.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(run.llm.requests), len(rows))
        story_dir = calls.parent / "story"
        requests = list(story_dir.rglob("*.request.json"))
        self.assertEqual(len(rows), len(requests))
        for req in requests:
            self.assertTrue(req.with_name(req.name.replace(".request.json", ".response.raw.txt")).is_file(), req.name)
        mapping_request = (story_dir / "pictures" / "pictures.map.request.json").read_text(encoding="utf-8")
        self.assertNotIn("iVBOR", mapping_request, "the pictures are logged by hash, not as base64")
        self.assertTrue((calls.parent / "job.json").is_file() and (calls.parent / "clips.json").is_file())

    def test_progress_messages_in_the_panel(self):
        run = self.run_engine("ninfer")
        messages = [m for _stage, m, _p in run.rec.progress]
        n = META["clips"]
        for want in ("story_engine=e4", "E4: story planned", "E4: film bible written", "reference pictures bound", f"clip 1/{n} staged", f"clip {n}/{n} written"):
            self.assertTrue(any(want in m for m in messages), f"no progress message with '{want}': {messages}")
        fractions = [p for _s, _m, p in run.rec.progress]
        self.assertTrue(all(0 <= p <= 1 for p in fractions))
        self.assertTrue(any("e4: planned and wrote" in n_ for n_ in run.notes))

    # ---- what e4 does not do (v1)
    def test_typed_clips_fall_back_to_the_builder_planner(self):
        clips = builder_scenario.clips_empty(2)
        clips[0]["prompt"] = "Ana leaves her flat in the rain."
        with e4_mock_llm.MockLLM(REPLAY) as llm:
            rec, notes, done = stub_pack.run_rewrite(ROOT, settings_for(self.story, auto_clips=3), clips, refs=stub_pack.make_pictures((0, 1)), writer_suffix=".ninfer",
                                                    server_base=llm.url, user_dir=Path(tempfile.mkdtemp(dir=self.user)))
        self.assertEqual([], llm.requests, "E4 was not started")
        self.assertTrue(any("story_engine=e4 is not used for this run" in m for _s, m, _p in rec.progress))
        self.assertTrue(rec.chats, "the builder planner ran instead")
        self.assertTrue(all(c.get("rewrite_meta", {}).get("engine") != "e4" for c in done))

    def test_no_picture_falls_back_to_the_builder(self):
        with e4_mock_llm.MockLLM(REPLAY) as llm:
            rec, notes, done = stub_pack.run_rewrite(ROOT, settings_for(self.story, rewrite_task="auto"), builder_scenario.clips_empty(1), refs={}, writer_suffix=".ninfer",
                                                    server_base=llm.url, user_dir=Path(tempfile.mkdtemp(dir=self.user)))
        self.assertEqual([], llm.requests)
        self.assertTrue(any("no reference picture" in m for _s, m, _p in rec.progress))

    STRATA = "Strata - Qwen3.8-Flash-Next (local endpoint, 5090)"

    def run_strata(self, notes, mapping=default_mapping):
        user = Path(tempfile.mkdtemp(dir=self.user))
        with e4_mock_llm.MockLLM(REPLAY, mapping=mapping) as llm:
            rec, _notes, clips = stub_pack.run_rewrite(
                ROOT, settings_for(self.story, rewrite_writer_model=self.STRATA, e4_picture_notes=notes), builder_scenario.clips_empty(1),
                refs=stub_pack.make_pictures([n - 1 for n in self.labels]), server_base=llm.url, model_id="qwen3.8-flash-next-iq3_s", vision=False, user_dir=user, strata=True)
        return llm, rec, clips, user

    def test_a_writer_that_cannot_see_binds_by_the_picture_notes(self):
        notes = "1: Jhanvi, the surveyor\n2: the torch\n3: the measuring tape\n4: the stepwell"
        llm, rec, clips, user = self.run_strata(notes)
        self.assertEqual([], llm.misses)
        self.assertEqual({"chat"}, {r["wire"] for r in llm.requests}, "Strata is called on chat completions")
        calls = [r for r in llm.requests if "binding the reference pictures" in json.dumps(r["body"]["messages"])]
        self.assertEqual(1, len(calls))
        content = calls[0]["body"]["messages"][0]["content"]
        self.assertIsInstance(content, str, "no picture goes to a model that cannot see")
        self.assertIn("You cannot see the pictures", content)
        self.assertIn("Picture 2: the torch", content)
        mapping = json.loads(next(user.rglob("map.json")).read_text(encoding="utf-8"))
        self.assertEqual("labels", mapping["mode"])
        self.assertTrue(all("<Picture" in c["prompt"] for c in clips))

    def test_node_missing_is_a_clear_error(self):
        saved = dict(os.environ)
        os.environ[e4_engine.NODE_ENV] = str(self.user / "no-such-node")
        os.environ["PATH"] = str(self.user)
        try:
            with e4_mock_llm.MockLLM(REPLAY) as llm:
                with self.assertRaises(Exception) as ctx:
                    stub_pack.run_rewrite(ROOT, settings_for(self.story), builder_scenario.clips_empty(1), refs=stub_pack.make_pictures((0, 1)), writer_suffix=".ninfer",
                                          server_base=llm.url, user_dir=Path(tempfile.mkdtemp(dir=self.user)))
        finally:
            os.environ.clear()
            os.environ.update(saved)
        self.assertEqual("E4Error", type(ctx.exception).__name__)
        self.assertIn(e4_engine.NODE_ENV, str(ctx.exception))
        self.assertIn("e4_node.txt", str(ctx.exception))

    def test_a_writer_without_a_server_is_refused(self):
        with e4_mock_llm.MockLLM(REPLAY) as llm:
            with self.assertRaises(RuntimeError) as ctx:
                stub_pack.run_rewrite(ROOT, settings_for(self.story), builder_scenario.clips_empty(1), refs=stub_pack.make_pictures((0, 1)), writer_suffix=".gguf", vision=False,
                                      server_base=llm.url, user_dir=Path(tempfile.mkdtemp(dir=self.user)))
        self.assertIn("server", str(ctx.exception))


def e4_pending(clips):
    import prompt_rewriter as pr
    return pr.pending_indices(clips, "pending clips", None, "raw asks")


class Ns:
    def __init__(self, **kw):
        self.__dict__.update(kw)


# --------------------------------------------------------------------------- builder mode is unchanged


@needs_imaging
class BuilderUnchanged(unittest.TestCase):
    """The same scenarios the base commit ran (tests/builder_scenario.py): story mode with the builder engine makes the same requests, byte for byte."""

    GOLDEN = FIXTURES / "builder_story_b12b03d.json"

    def test_without_the_new_widgets(self):
        self.assertEqual(self.GOLDEN.read_text(encoding="utf-8"), stub_pack.dumps(builder_scenario.record(ROOT)) + "\n")

    def test_with_the_new_widgets_at_their_defaults(self):
        self.assertEqual(self.GOLDEN.read_text(encoding="utf-8"), stub_pack.dumps(builder_scenario.record(ROOT, with_new_widgets=True)) + "\n")

    def test_the_golden_file_would_notice_a_change(self):
        data = json.loads(self.GOLDEN.read_text(encoding="utf-8"))
        data["story_auto_raw_asks"]["chats"][0]["kw"]["seed"] += 1
        self.assertNotEqual(self.GOLDEN.read_text(encoding="utf-8"), stub_pack.dumps(data) + "\n")


# --------------------------------------------------------------------------- the vendored copy


@needs_node
class FrozenCopy(unittest.TestCase):
    def verify(self, root, *args):
        return subprocess.run([NODE, str(Path(root) / "e4" / "verify-frozen.mjs"), *args], capture_output=True, text=True, cwd=str(root))

    def test_the_vendored_copy_is_the_frozen_one(self):
        r = self.verify(ROOT)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertIn("0 problem(s)", r.stdout)

    def tree(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        shutil.copytree(ROOT / "e4", tmp / "e4", ignore=shutil.ignore_patterns("node_modules"))
        return tmp

    def test_a_changed_frozen_file_is_caught(self):
        tmp = self.tree()
        target = tmp / "e4" / "planpath46" / "planner.mjs"
        target.write_text(target.read_text(encoding="utf-8") + "\n// edited\n", encoding="utf-8")
        r = self.verify(tmp)
        self.assertEqual(1, r.returncode)
        self.assertIn("CHANGED e4/planpath46/planner.mjs", r.stdout)

    def test_an_edit_inside_a_patched_file_outside_the_patch_is_caught(self):
        tmp = self.tree()
        target = tmp / "e4" / "planpath46" / "film.mjs"
        text = target.read_text(encoding="utf-8")
        target.write_text(text.replace("const pad = (n)", "const padd = (n)", 1), encoding="utf-8")
        r = self.verify(tmp)
        self.assertEqual(1, r.returncode)
        manifest = json.loads((tmp / "e4" / "MANIFEST.json").read_text(encoding="utf-8"))
        for f in manifest["files"]:
            if f["path"] == "e4/planpath46/film.mjs":
                f["vendoredSha256"] = __import__("hashlib").sha256(target.read_bytes()).hexdigest()
        (tmp / "e4" / "MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
        r = self.verify(tmp)
        self.assertEqual(1, r.returncode, "even with the manifest updated, the patched file must reverse to the source")
        self.assertIn("DIFFERS e4/planpath46/film.mjs", r.stdout)

    def test_an_unlisted_file_is_caught(self):
        tmp = self.tree()
        (tmp / "e4" / "hybrid3" / "extra.mjs").write_text("export {};\n", encoding="utf-8")
        r = self.verify(tmp)
        self.assertEqual(1, r.returncode)
        self.assertIn("EXTRA e4/hybrid3/extra.mjs", r.stdout)

    def test_the_declared_patches_are_the_only_differences_to_the_tag(self):
        tag = os.environ.get("E4_EVAL_REPO")
        if not tag:
            self.skipTest("set E4_EVAL_REPO to the h3-prompt-eval checkout to compare with the git tag e4.6-frozen")
        r = self.verify(ROOT, "--eval-repo", tag)
        self.assertEqual(0, r.returncode, r.stdout + r.stderr)
        self.assertRegex(r.stdout, r"\d+ against the git tag")

    def test_e4_has_no_package_dependency_and_no_dot_env_is_needed(self):
        home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, home, True)
        env = dict(os.environ, HOME=str(home), USERPROFILE=str(home))
        for entry in ("planpath46/film.mjs", "bridge/run.mjs"):
            if entry == "bridge/run.mjs":
                continue
            r = subprocess.run([NODE, "--input-type=module", "-e", f"await import('{(ROOT / 'e4' / entry).as_uri()}'); console.log('ok')"], capture_output=True, text=True, env=env)
            self.assertEqual(0, r.returncode, r.stderr[-600:])
        self.assertFalse(list((ROOT / "e4").rglob("package-lock.json")) or list((ROOT / "e4").rglob("node_modules")))

    def test_bridge_unit_tests(self):
        r = subprocess.run([NODE, "--test", str(ROOT / "e4" / "bridge" / "test" / "bridge.test.mjs")], capture_output=True, text=True, cwd=str(ROOT / "e4"))
        self.assertEqual(0, r.returncode, r.stdout[-2500:] + r.stderr[-1000:])


# --------------------------------------------------------------------------- the Python side


class PythonSide(unittest.TestCase):
    def test_parse_notes(self):
        notes = e4_engine.parse_notes("1: the shopkeeper, an old man\nPicture 2 - the shop with the green door\nnot a note\n3) a tea glass\n4:   \n")
        self.assertEqual({1: "the shopkeeper, an old man", 2: "the shop with the green door", 3: "a tea glass"}, notes)
        self.assertEqual({}, e4_engine.parse_notes(None))

    def test_decision_budget_maps_to_the_nearest_allowed(self):
        self.assertEqual(2048, e4_engine.decision_budget("2048"))
        self.assertEqual(1024, e4_engine.decision_budget(1))
        self.assertEqual(4096, e4_engine.decision_budget(99999))
        self.assertEqual(2048, e4_engine.decision_budget("junk"))

    def test_endpoint_styles(self):
        server = type("S", (), {"base": "http://127.0.0.1:9/", "model_id": "swift-1.5"})()
        self.assertEqual({"url": "http://127.0.0.1:9", "model": "swift-1.5", "style": "ninfer-messages"},
                         e4_engine.endpoint_of(server, model_path="a.ninfer", strata=False, is_ninfer=lambda p: p.endswith(".ninfer")))
        self.assertEqual("llama-chat", e4_engine.endpoint_of(server, model_path="a.gguf", strata=False, is_ninfer=lambda p: p.endswith(".ninfer"))["style"])
        strata = type("S", (), {"base": "http://127.0.0.1:8095", "model": "qwen3.8-flash-next-iq3_s"})()
        self.assertEqual({"url": "http://127.0.0.1:8095", "model": "qwen3.8-flash-next-iq3_s", "style": "llama-chat"},
                         e4_engine.endpoint_of(strata, model_path="", strata=True, is_ninfer=lambda p: False))
        with self.assertRaises(e4_engine.E4Error):
            e4_engine.endpoint_of(object(), model_path="a", strata=False, is_ninfer=lambda p: False)

    def test_env_carries_the_budgets_and_clears_stale_e4_variables(self):
        os.environ["E4_LLM_BUDGET"] = "999"
        try:
            env = e4_engine.build_env({"url": "u", "model": "m", "style": "llama-chat"}, decision=1024, score="on")
        finally:
            del os.environ["E4_LLM_BUDGET"]
        self.assertNotIn("E4_LLM_BUDGET", env)
        for kind in ("PLANNER", "BIBLE", "WRITER", "REPAIR"):
            self.assertEqual("4096", env[f"E4_LLM_BUDGET_{kind}"])
        self.assertEqual("1024", env["E4_LLM_BUDGET_DECISION"])
        self.assertEqual("on", env["E4_SCORE"])

    def test_find_node_prefers_env_then_file_then_path(self):
        if not NODE:
            self.skipTest("no node")
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        saved = os.environ.pop(e4_engine.NODE_ENV, None)
        try:
            (tmp / e4_engine.NODE_FILE).write_text(f"{NODE}\n", encoding="utf-8")
            self.assertEqual(NODE, e4_engine.find_node(tmp))
            os.environ[e4_engine.NODE_ENV] = "/definitely/not/node"
            self.assertEqual(NODE, e4_engine.find_node(tmp), "a bad entry is skipped for the next source")
        finally:
            os.environ.pop(e4_engine.NODE_ENV, None)
            if saved:
                os.environ[e4_engine.NODE_ENV] = saved

    def result(self, n=3, failed=()):
        clips = []
        for i in range(1, n + 1):
            c = {"clip": i, "title": f"beat {i}", "beat": f"beat {i}", "rawAsk": f"raw ask {i}", "endState": {"location": "x", "characters": []}}
            if i in failed:
                c.update(prompt=None, failed="no parseable reply")
            else:
                c.update(prompt=f"subject_definitions:\nfinal {i}", duration=15, durationExact=15.08, pictures=[{"picture": 2, "entity": "a"}], checks={"citationIssues": []})
            clips.append(c)
        return {"version": "e4.6-frozen", "clips": clips, "stats": {"wallSecs": 60}}

    def test_apply_clips_fills_empty_clips_then_appends(self):
        clips = [{"id": 7, "title": "My opening", "prompt": "", "duration": 15, "seed": 5, "loras": ["x"]}, {"id": 8, "title": "Clip 2", "prompt": "", "duration": 10}]
        written = e4_engine.apply_clips(clips, self.result(3), model="m")
        self.assertEqual([0, 1, 2], written)
        self.assertEqual("My opening", clips[0]["title"], "a title the user gave is kept")
        self.assertEqual(["x"], clips[0]["loras"])
        self.assertEqual(5, clips[0]["seed"])
        self.assertEqual("Clip 2: beat 2", clips[1]["title"])
        again = e4_engine.apply_clips(clips, self.result(3), model="m")
        self.assertEqual("Clip 2: beat 2", clips[1]["title"], "a title this engine wrote is replaced by the next plan's, a user's title is not")
        self.assertEqual("My opening", clips[0]["title"])
        self.assertEqual(9, clips[2]["id"])
        self.assertTrue(all(c["prompt_rewritten"] and c["planned"] and c["duration"] == 15 for c in clips))
        self.assertEqual("final 3", clips[2]["prompt"].split("\n")[1].replace("final ", "final "))

    def test_a_failed_clip_keeps_its_ask_for_the_builder(self):
        clips = [{"id": 0, "title": "Clip 1", "prompt": ""}]
        e4_engine.apply_clips(clips, self.result(3, failed=(2,)), model="m")
        self.assertFalse(clips[1]["prompt_rewritten"])
        self.assertEqual("raw ask 2", clips[1]["prompt"])
        self.assertTrue(clips[1]["planned"])
        self.assertTrue(clips[0]["prompt_rewritten"] and clips[2]["prompt_rewritten"])

    def test_progress_messages(self):
        seen = {}
        message, fraction = e4_engine.progress_message({"kind": "writer", "clip": 2, "name": "round0.write", "secs": 31.2}, 3, seen)
        self.assertIn("clip 2/3 written", message)
        self.assertGreater(fraction, 0.5)
        self.assertIn("film bible", e4_engine.progress_message({"kind": "bible", "name": "bible"}, None, seen)[0])

    def test_run_dir_resumes_an_unfinished_run_and_archives_a_finished_one(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, True)
        run, resume = e4_engine.pick_run_dir(root, "abc")
        self.assertFalse(resume)
        (run / "story").mkdir()
        (run / "story" / "plan.json").write_text("{}", encoding="utf-8")
        again, resume = e4_engine.pick_run_dir(root, "abc")
        self.assertEqual((run, True), (again, resume))
        (run / ".done").write_text("x", encoding="utf-8")
        fresh, resume = e4_engine.pick_run_dir(root, "abc")
        self.assertFalse(resume)
        self.assertEqual(run, fresh)
        self.assertEqual(2, len(list(root.iterdir())), "the finished run was archived under a time-stamped name")


if __name__ == "__main__":
    unittest.main()
