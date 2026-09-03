"""
Minimal LLM client for the LangGraph research service - talks directly to the SAME local Ollama
instance Argus's own Node side already uses (config/aiModels.json's ollama.baseUrl,
http://127.0.0.1:11434/v1), over its OpenAI-compatible chat endpoint. Deliberately does NOT
duplicate Argus's full AIRouter/provider-abstraction/HeavyModelMutex machinery - that exists to
route across 10 paid+local providers for the live trading path; this is one narrow, local, free,
advisory-only call, so a second full router would be unjustified infrastructure for what it does.

Handles connection failures, timeouts, and malformed output explicitly - never fabricates a
response. Bounded retries only on transient connection/timeout errors (config.OLLAMA_MAX_RETRIES),
never on a clearly non-retryable case (e.g. a 4xx from the endpoint itself).

chat_json() mirrors the exact defensive JSON-extraction discipline
AIOutputValidator.ts's parseJsonFromLlmContent() already established on the Node side this same
session (strip a ```json fence, then try a bare first-{-to-last-} extraction) - the same class of
model behavior (wrapping JSON in prose or a fence) can happen from any OpenAI-compatible backend,
Ollama included.
"""
from __future__ import annotations

import json
import time
from typing import Any, Dict, Optional, Tuple

import requests

from . import config


def _extract_json(text: str) -> Optional[Any]:
    trimmed = text.strip()
    candidates = [trimmed]

    fenced = trimmed
    if fenced.startswith("```json"):
        fenced = fenced[len("```json"):]
    elif fenced.startswith("```"):
        fenced = fenced[len("```"):]
    if fenced.endswith("```"):
        fenced = fenced[: -len("```")]
    fenced = fenced.strip()
    if fenced != trimmed:
        candidates.append(fenced)

    first_brace = trimmed.find("{")
    last_brace = trimmed.rfind("}")
    if first_brace >= 0 and last_brace > first_brace:
        candidates.append(trimmed[first_brace : last_brace + 1])

    for candidate in candidates:
        try:
            return json.loads(candidate)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def _chat_once(prompt: str, temperature: float, max_tokens: int) -> Tuple[Optional[str], Optional[str]]:
    url = f"{config.OLLAMA_BASE_URL}/v1/chat/completions"
    body = {
        "model": config.OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    try:
        res = requests.post(url, json=body, timeout=config.OLLAMA_REQUEST_TIMEOUT_S)
    except requests.exceptions.Timeout:
        return None, "PROVIDER_TIMEOUT"
    except requests.exceptions.RequestException as e:
        return None, f"PROVIDER_UNREACHABLE: {e}"

    if res.status_code == 429:
        return None, "PROVIDER_RATE_LIMITED"
    if res.status_code in (401, 403):
        return None, "PROVIDER_AUTH_FAILED"
    if not res.ok:
        return None, f"PROVIDER_HTTP_{res.status_code}"

    try:
        data = res.json()
        content = data["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None, "PROVIDER_MALFORMED_RESPONSE"

    if not isinstance(content, str) or not content.strip():
        return None, "PROVIDER_EMPTY_RESPONSE"

    return content, None


def chat(prompt: str, temperature: float = 0.2, max_tokens: int = 700) -> Tuple[Optional[str], Optional[str]]:
    """Returns (text, None) on success, or (None, error_code) on failure. Never raises, never
    fabricates a response on failure - bounded retries only for transient timeout/connection
    errors, per config.OLLAMA_MAX_RETRIES."""
    last_error = "PROVIDER_UNAVAILABLE"
    attempts = 1 + max(0, config.OLLAMA_MAX_RETRIES)
    for attempt in range(attempts):
        text, error = _chat_once(prompt, temperature, max_tokens)
        if text is not None:
            return text, None
        last_error = error or last_error
        if error not in ("PROVIDER_TIMEOUT", "PROVIDER_UNREACHABLE"):
            break  # non-transient failure - retrying will not help
        if attempt < attempts - 1:
            time.sleep(0.5 * (attempt + 1))
    return None, last_error


def chat_json(prompt: str, temperature: float = 0.2, max_tokens: int = 700) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Same contract as chat(), but additionally requires the model's output to parse as a JSON
    object. A response that comes back but doesn't parse is PROVIDER_MALFORMED_RESPONSE - never
    silently coerced into a fabricated structure."""
    text, error = chat(prompt, temperature=temperature, max_tokens=max_tokens)
    if text is None:
        return None, error
    parsed = _extract_json(text)
    if not isinstance(parsed, dict):
        return None, "PROVIDER_MALFORMED_RESPONSE"
    return parsed, None
