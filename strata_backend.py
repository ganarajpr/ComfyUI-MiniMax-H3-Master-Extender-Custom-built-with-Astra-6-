"""Strata (Qwen3.8-Flash-Next on the 5090) as a writer backend for the built-in rewriter.

The rewriter pack can only spawn a llama-server / ninfer-serve of its own from a
local model file, so a model that already lives behind an HTTP endpoint cannot be
picked there. This module is the other half: an OpenAI-chat client for one such
endpoint, with the same ``chat()`` the pack's ``Server`` has, so the planner and
the clip writers call it unchanged.

Where the endpoint comes from, in order:

1. ``MINIMAX_H3_STRATA_URL`` set: attach to exactly that, never start anything.
2. ``http://127.0.0.1:8095`` (the gateway lane's own port) already answering
   ``/health``: attach to it. The process is not ours, so it is never killed;
   the model is unloaded on release (``POST /v1/unload``) so the card goes back
   to ComfyUI.
3. Nothing answering: start Strata the way the GPU gateway's ``strata`` backend
   does (command read from the gateway's ``backends.json``), on a private port,
   and kill it on release. The gateway cannot do this for us: a request to
   ``/strata`` made from inside a running ComfyUI job is refused by its render
   guard (503), and with the queue idle it would evict ComfyUI.

Always direct to the loopback port, never through the gateway at :9000.

Strata specifics (read from its server, not guessed): the thinking budget is a
top-level ``reasoning_budget_tokens`` and its wrap-up message is built in (there
is no per-request message field); ``chat_template_kwargs.enable_thinking`` can
only switch thinking off; ``repeat_penalty`` is not part of its sampling; one
sequence runs at a time; the config has no vision entry, so no image parts.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

_LOG = logging.getLogger("minimax_h3_master_extender.strata")

LABEL = "Strata - Qwen3.8-Flash-Next (local endpoint, 5090)"
DEFAULT_URL = "http://127.0.0.1:8095"
MODEL_ID = "qwen3.8-flash-next-iq3_s"
DEFAULT_BUDGET = 4096

URL_ENV = "MINIMAX_H3_STRATA_URL"
GATEWAY_CONFIG_ENV = "MINIMAX_H3_GPU_GATEWAY_CONFIG"
GATEWAY_LANE = "strata"

STARTUP_SECONDS = 420.0
REQUEST_SECONDS = 900.0
HEALTH_INTERVAL = 1.0
RETRY_SECONDS = 5.0


class StrataUnavailable(RuntimeError):
    pass


def request_body(messages: list[dict], *, seed: int, greedy: bool, max_new_tokens: int, temperature: float = 0.7,
                 top_p: float = 0.8, top_k: int = 20, thinking: bool, budget: int, model: str = MODEL_ID) -> dict:
    """The chat request. Thinking carries its budget on every call, even when it is off."""
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_new_tokens),
        "seed": int(seed),
        "stream": True,
        "reasoning_budget_tokens": int(budget) if int(budget) > 0 else DEFAULT_BUDGET,
        "chat_template_kwargs": {"enable_thinking": bool(thinking)},
    }
    if greedy:
        body["temperature"] = 0.0
    else:
        body.update(temperature=float(temperature), top_p=float(top_p), top_k=int(top_k))
    return body


def _delta(raw: bytes) -> tuple[str, str]:
    line = raw.decode("utf-8", errors="replace").strip()
    if not line.startswith("data:"):
        return "", ""
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return "", ""
    try:
        parsed = json.loads(payload)
    except ValueError:
        return "", ""
    if isinstance(parsed.get("error"), dict):
        raise RuntimeError(f"Strata stream error: {parsed['error'].get('message', parsed['error'])}")
    delta = ((parsed.get("choices") or [{}])[0].get("delta")) or {}
    return delta.get("content") or "", delta.get("reasoning_content") or ""


def _interrupted() -> bool:
    try:
        import comfy.model_management as mm

        return bool(mm.processing_interrupted())
    except Exception:
        return False


def _healthy(base: str) -> bool:
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=2) as answer:
            return answer.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


class StrataServer:
    """One Strata endpoint, asked through ``chat()`` like the pack's own server."""

    def __init__(self, base: str, model: str = MODEL_ID, budget: int = DEFAULT_BUDGET, process=None):
        self.base = base.rstrip("/")
        self.model = model
        self.budget = budget if budget > 0 else DEFAULT_BUDGET
        self.process = process

    def chat(self, messages: list[dict], seed: int = 42, greedy: bool = True, max_new_tokens: int = 2048,
             temperature: float = 0.7, top_p: float = 0.8, top_k: int = 20, repeat_penalty: float | None = None,
             enable_thinking: bool | None = None, on_text=None, on_reasoning=None) -> str:
        # repeat_penalty is accepted for the pack's signature and dropped: Strata does not sample with it.
        body = request_body(messages, seed=seed, greedy=greedy, max_new_tokens=max_new_tokens,
                            temperature=temperature, top_p=top_p, top_k=top_k,
                            thinking=bool(enable_thinking), budget=self.budget, model=self.model)
        data = json.dumps(body).encode("utf-8")
        give_up = time.monotonic() + STARTUP_SECONDS
        while True:
            request = urllib.request.Request(f"{self.base}/v1/chat/completions", data=data,
                                             headers={"Content-Type": "application/json"})
            try:
                return self._read(request, on_text, on_reasoning)
            except urllib.error.HTTPError as error:
                detail = error.read().decode("utf-8", errors="replace")[:600]
                # An unloaded Strata (idle unload, or still loading) answers 503 "starting; try again shortly".
                if error.code == 503 and "starting" in detail and time.monotonic() < give_up:
                    time.sleep(RETRY_SECONDS)
                    continue
                raise RuntimeError(f"Strata refused the request ({error.code}): {detail}") from error
            except (urllib.error.URLError, OSError) as error:
                raise RuntimeError(f"Strata stopped answering at {self.base}: {error}") from error

    def _read(self, request, on_text, on_reasoning) -> str:
        pieces: list[str] = []
        thoughts: list[str] = []
        with urllib.request.urlopen(request, timeout=REQUEST_SECONDS) as answer:
            for raw in answer:
                if _interrupted():
                    import comfy.model_management as mm

                    raise mm.InterruptProcessingException()
                piece, thought = _delta(raw)
                if thought:
                    thoughts.append(thought)
                    if on_reasoning is not None:
                        on_reasoning("".join(thoughts))
                if not piece:
                    continue
                pieces.append(piece)
                if on_text is not None and on_text("".join(pieces)):
                    break
        return "".join(pieces).strip()

    def unload(self) -> str:
        """Give the card back without stopping the process. Never raises: busy or old servers are fine."""
        request = urllib.request.Request(f"{self.base}/v1/unload", data=b"{}", method="POST",
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=60) as answer:
                return f"HTTP {answer.status}"
        except urllib.error.HTTPError as error:
            return f"HTTP {error.code}"
        except (urllib.error.URLError, OSError):
            return "unreachable"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _gateway_config_path() -> str:
    given = os.environ.get(GATEWAY_CONFIG_ENV)
    if given:
        return given
    here = os.path.dirname(os.path.abspath(__file__))
    # <portable>/ComfyUI/custom_nodes/<this pack> -> <Projects>/gpu-gateway/backends.json beside <portable>
    return os.path.normpath(os.path.join(here, "..", "..", "..", "..", "gpu-gateway", "backends.json"))


def launch_spec(port: int) -> dict | None:
    """The gateway's own ``strata`` command with the port swapped, or None without a gateway config."""
    try:
        with open(_gateway_config_path(), "r", encoding="utf-8") as handle:
            lane = json.load(handle)["backends"][GATEWAY_LANE]
        command = [str(part) for part in lane["cmd"]]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if "--port" in command[:-1]:
        command[command.index("--port") + 1] = str(port)
    else:
        command += ["--port", str(port)]
    return {"cmd": command, "cwd": lane.get("cwd") or None, "env": dict(lane.get("env") or {})}


def _spawn(spec: dict, adopt=None):
    environment = dict(os.environ)
    environment.update(spec["env"])
    log_path = os.path.join(tempfile.gettempdir(), "minimax_h3_strata.log")
    log_file = open(log_path, "ab", buffering=0)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
    _LOG.info("starting Strata: %s (log %s)", " ".join(spec["cmd"]), log_path)
    process = subprocess.Popen(spec["cmd"], cwd=spec["cwd"], env=environment, stdin=subprocess.DEVNULL,
                               stdout=log_file, stderr=subprocess.STDOUT, creationflags=flags)
    if adopt is not None:
        try:
            adopt(process)
        except Exception:
            _LOG.debug("not adopted", exc_info=True)
    return process


def _stop(process) -> None:
    if process is None or process.poll() is not None:
        return
    try:
        import psutil

        victims = psutil.Process(process.pid).children(recursive=True) + [psutil.Process(process.pid)]
        for victim in victims:
            with contextlib.suppress(psutil.NoSuchProcess):
                victim.kill()
        psutil.wait_procs(victims, timeout=15)
    except ImportError:
        process.kill()
    except Exception:
        _LOG.debug("tree kill failed", exc_info=True)
        process.kill()
    with contextlib.suppress(Exception):
        process.wait(timeout=15)


def free_comfy_vram() -> None:
    """Strata takes the whole card: put ComfyUI's models away first, as the pack does for its own writers."""
    try:
        import comfy.model_management as mm

        mm.unload_all_models()
        mm.soft_empty_cache(force=True)
    except Exception:
        _LOG.debug("free_comfy_vram skipped", exc_info=True)


@contextlib.contextmanager
def open_strata(budget: int = DEFAULT_BUDGET, adopt=None, on_wait=None):
    """Yield a ready :class:`StrataServer`; on exit kill what we started, or unload what we attached to."""
    explicit = (os.environ.get(URL_ENV) or "").strip()
    base = explicit.rstrip("/") or DEFAULT_URL
    process = None
    free_comfy_vram()
    if _healthy(base):
        _LOG.info("Strata: attached to %s (not ours: unloaded, not killed, on release)", base)
    elif explicit:
        raise StrataUnavailable(f"Strata does not answer at {base} ({URL_ENV}); start it, or unset {URL_ENV}.")
    else:
        port = _free_port()
        spec = launch_spec(port)
        if spec is None:
            raise StrataUnavailable(
                f"Strata does not answer at {base} and no GPU gateway config was found to start it from "
                f"(set {GATEWAY_CONFIG_ENV} to its backends.json, or {URL_ENV} to a running Strata).")
        process = _spawn(spec, adopt)
        base = f"http://127.0.0.1:{port}"
        started = time.monotonic()
        try:
            while not _healthy(base):
                if process.poll() is not None:
                    raise StrataUnavailable(f"Strata exited with code {process.returncode} while loading "
                                            f"(log: {os.path.join(tempfile.gettempdir(), 'minimax_h3_strata.log')}).")
                if time.monotonic() - started > STARTUP_SECONDS:
                    raise StrataUnavailable(f"Strata did not answer /health within {STARTUP_SECONDS:.0f} s.")
                if on_wait is not None:
                    on_wait(time.monotonic() - started)
                time.sleep(HEALTH_INTERVAL)
        except BaseException:
            _stop(process)
            raise
        _LOG.info("Strata: started on %s in %.0f s", base, time.monotonic() - started)
    server = StrataServer(base, MODEL_ID, budget, process)
    try:
        yield server
    finally:
        if process is not None:
            _stop(process)
            _LOG.info("Strata: stopped")
        else:
            _LOG.info("Strata: released (%s)", server.unload())
