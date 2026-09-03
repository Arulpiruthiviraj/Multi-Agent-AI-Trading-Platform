"""
Environment-driven configuration for the LangGraph research service. No secrets live here - the
one model backend (local Ollama) needs no API key. Mirrors the env-var convention
config/langGraphResearch.json already declares on the Node side (LANGGRAPH_RESEARCH_PORT is set by
scripts/lib/langGraphLauncher.ts when it spawns this process; every value still has a safe default
so the service is independently startable without Node, e.g. for local development or tests).
"""
import os

GRAPH_VERSION = "strategy-graduation-v2"

PORT = int(os.environ.get("LANGGRAPH_RESEARCH_PORT", "8090"))

# Loopback only - never trust an external ARGUS_BASE_URL that isn't 127.0.0.1/localhost. This
# service must never be pointed at a remote Argus instance; the whole safety boundary
# (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md) assumes both processes are on the same host.
ARGUS_BASE_URL = os.environ.get("ARGUS_BASE_URL", "http://127.0.0.1:3000")
if not (ARGUS_BASE_URL.startswith("http://127.0.0.1") or ARGUS_BASE_URL.startswith("http://localhost")):
    raise RuntimeError(f"ARGUS_BASE_URL must be a loopback URL, got: {ARGUS_BASE_URL!r}")

ARGUS_REQUEST_TIMEOUT_S = float(os.environ.get("ARGUS_REQUEST_TIMEOUT_S", "10"))

OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("LANGGRAPH_RESEARCH_MODEL", "llama3.2:latest")
OLLAMA_REQUEST_TIMEOUT_S = float(os.environ.get("OLLAMA_REQUEST_TIMEOUT_S", "25"))
OLLAMA_MAX_RETRIES = int(os.environ.get("OLLAMA_MAX_RETRIES", "1"))

# Bounds the whole graph run (fetch + up to 2 LLM calls + validation). Kept comfortably below the
# Node client's own requestTimeoutMs (config/langGraphResearch.json, default 45000ms) so this
# service returns a clean FAILED envelope before Node's own AbortSignal.timeout would fire.
MAX_GRAPH_EXECUTION_S = float(os.environ.get("LANGGRAPH_MAX_EXECUTION_S", "35"))

LOG_PATH = os.environ.get("LANGGRAPH_RESEARCH_LOG_PATH")  # optional; stdout always used too
