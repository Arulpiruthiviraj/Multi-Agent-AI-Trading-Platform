#!/usr/bin/env python3
"""
Bootstraps the local hybrid AI stack (Ollama models + Python ML packages + Hugging Face
model cache) that TechnicalAgent/NewsEngine/KronosForecastAgent are meant to call into
instead of a frontier LLM for every tick and headline.

Usage:
    python scripts/bootstrap_models.py
    npm run setup:ai

Idempotent: re-running is safe. `ollama pull`/`ollama create` are no-ops if the model
already matches, and the Hugging Face warm-up uses the local cache once populated.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_MODELS = ["llama3.2:latest", "llama3.2:1b", "0xroyce/plutus:latest"]

# FinGPT has no official single-file GGUF Ollama can pull directly (hf.co/FinGPT's repos are
# LoRA adapters, not a merged GGUF, and Ollama's `hf.co/...` pull path requires the exact
# huggingface.co host - not the hf.co shortlink - and a repo that actually contains a GGUF).
# Rather than guess a URL that might not exist or point somewhere untrusted, this expects you
# to have already obtained/converted the GGUF yourself (as documented in
# docs/LOCAL_AI_SETUP.md) and placed it at FINGPT_GGUF_PATH.
FINGPT_GGUF_PATH = Path(os.environ.get("FINGPT_GGUF_PATH", REPO_ROOT / "models" / "fingpt.gguf"))
FINGPT_MODEL_NAME = "fingpt"

HF_WARMUP_MODELS = ["ProsusAI/finbert", "amazon/chronos-t5-mini"]


def log(msg: str) -> None:
    print(f"[bootstrap_models] {msg}", flush=True)


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    log("$ " + " ".join(cmd))
    return subprocess.run(cmd, **kwargs)


OLLAMA_EXE = "ollama"


def check_python() -> None:
    log(f"Python {sys.version.split()[0]} at {sys.executable}")


def check_ollama_installed() -> bool:
    global OLLAMA_EXE
    path = shutil.which("ollama")
    if path:
        log(f"Ollama CLI found at {path}")
        return True

    # Windows' Ollama installer can add itself to the current user's PATH in a way that doesn't
    # propagate to already-running shells/processes - fall back to the default install location
    # before giving up, since the server can be up and fully functional while this check alone
    # would otherwise report Ollama as "not installed".
    if sys.platform == "win32":
        fallback = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
        if fallback.exists():
            OLLAMA_EXE = str(fallback)
            log(f"Ollama CLI not on PATH, but found at {fallback} - using it directly.")
            return True

    log("Ollama CLI not found on PATH. Install it from https://ollama.com/download, then re-run this script.")
    return False


def check_ollama_running() -> bool:
    try:
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=3) as resp:
            json.loads(resp.read())
        log(f"Ollama server responding at {OLLAMA_HOST}")
        return True
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        log(f"Ollama server not reachable at {OLLAMA_HOST} ({e}). Start it with `ollama serve` and re-run.")
        return False


def install_python_requirements() -> bool:
    req_file = REPO_ROOT / "requirements-ai.txt"
    if not req_file.exists():
        log(f"requirements-ai.txt not found at {req_file}, skipping Python package install.")
        return False
    result = run([sys.executable, "-m", "pip", "install", "-r", str(req_file)])
    if result.returncode != 0:
        log("pip install failed - see output above.")
        return False
    log("Python ML dependencies installed.")
    return True


def pull_ollama_models() -> None:
    for model in OLLAMA_MODELS:
        result = run([OLLAMA_EXE, "pull", model])
        if result.returncode != 0:
            log(f"WARNING: failed to pull {model} - continuing with the rest.")


def build_fingpt_model() -> None:
    if not FINGPT_GGUF_PATH.exists():
        log(
            f"FinGPT GGUF not found at {FINGPT_GGUF_PATH} - skipping. "
            "See docs/LOCAL_AI_SETUP.md for how to obtain/convert it, then re-run this script "
            "(or set FINGPT_GGUF_PATH to point at an existing file)."
        )
        return

    modelfile_path = FINGPT_GGUF_PATH.parent / "Modelfile"
    modelfile_path.write_text(f"FROM {FINGPT_GGUF_PATH.name}\n")
    log(f"Wrote {modelfile_path}")

    result = run([OLLAMA_EXE, "create", FINGPT_MODEL_NAME, "-f", str(modelfile_path)], cwd=str(FINGPT_GGUF_PATH.parent))
    if result.returncode != 0:
        log(f"WARNING: `ollama create {FINGPT_MODEL_NAME}` failed - see output above.")
    else:
        log(f"'{FINGPT_MODEL_NAME}' Ollama model ready.")


def warmup_huggingface_models() -> None:
    try:
        import torch  # noqa: F401
        from transformers import pipeline, AutoModelForSeq2SeqLM, AutoTokenizer
    except ImportError as e:
        log(f"Skipping Hugging Face warm-up - Python ML deps not importable yet ({e}). Run this script again after pip install succeeds.")
        return

    log(f"Warming up {HF_WARMUP_MODELS[0]} (financial sentiment)...")
    try:
        sentiment = pipeline("sentiment-analysis", model=HF_WARMUP_MODELS[0])
        result = sentiment("Markets rallied on strong earnings.")
        log(f"  {HF_WARMUP_MODELS[0]} cached and working: {result}")
    except Exception as e:
        log(f"  WARNING: failed to warm up {HF_WARMUP_MODELS[0]}: {e}")

    log(f"Warming up {HF_WARMUP_MODELS[1]} (time-series forecasting)...")
    try:
        AutoTokenizer.from_pretrained(HF_WARMUP_MODELS[1])
        AutoModelForSeq2SeqLM.from_pretrained(HF_WARMUP_MODELS[1])
        log(f"  {HF_WARMUP_MODELS[1]} cached and working.")
    except Exception as e:
        log(f"  WARNING: failed to warm up {HF_WARMUP_MODELS[1]}: {e}")


def main() -> int:
    log("Starting local AI stack bootstrap...")
    check_python()

    ollama_ok = check_ollama_installed() and check_ollama_running()
    if ollama_ok:
        pull_ollama_models()
        build_fingpt_model()
    else:
        log("Skipping Ollama model pulls/build - fix the issue above and re-run.")

    deps_ok = install_python_requirements()
    if deps_ok:
        warmup_huggingface_models()
    else:
        log("Skipping Hugging Face warm-up since Python dependencies did not install cleanly.")

    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
