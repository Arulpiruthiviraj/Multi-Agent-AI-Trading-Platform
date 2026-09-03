"""
Structured, correlation-id-aware logging for the LangGraph research service. One JSON line per
event to stdout (captured into logs/langgraph-research.log by the Node-side launcher, matching
local_ai_service.py's own "print, Node redirects to a file" convention) - never a secret, token, or
raw model payload larger than a short preview.

Answers, per event, exactly what docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md's observability
section asks for: when a run started, which node executed, how long it took, which provider/model
was used, whether it failed, and the correlation/run id joining this to the Node-side log line for
the same request.
"""
import json
import sys
import time
from typing import Any


def _redact(value: Any, max_len: int = 300) -> Any:
    if isinstance(value, str) and len(value) > max_len:
        return value[:max_len] + f"...<truncated {len(value) - max_len} chars>"
    return value


def log_event(event: str, **fields: Any) -> None:
    """Never raises - a logging failure must never break a graph run."""
    try:
        record = {
            "ts": time.time(),
            "service": "langgraph-research",
            "event": event,
        }
        for k, v in fields.items():
            record[k] = _redact(v)
        print(json.dumps(record, default=str), file=sys.stdout, flush=True)
    except Exception:
        pass
