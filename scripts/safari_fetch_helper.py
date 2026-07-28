#!/usr/bin/env python3
"""Persistent curl_cffi Safari transport for SpankBang page requests.

The process reads one JSON object per line from stdin and writes one JSON
response per line to stdout. A single Session is retained for cookies and
Cloudflare state across catalog, metadata, and video-page requests.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any
from urllib.parse import urlparse

from curl_cffi import requests

ALLOWED_HOSTS = {"spankbang.com", "www.spankbang.com"}
HOME_URL = "https://spankbang.com/"
MAX_BYTES_HARD_LIMIT = 8 * 1024 * 1024

session = requests.Session(impersonate=os.getenv("SPANKBANG_IMPERSONATE", "safari"))
for cookie_name, cookie_value in {
    "sb": "1",
    "age_verified": "1",
    "hasVisited": "1",
}.items():
    session.cookies.set(cookie_name, cookie_value, domain="spankbang.com", path="/")

bootstrapped = False


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def validate_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("URL must be a string")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or host not in ALLOWED_HOSTS:
        raise ValueError("URL host is not approved for Safari transport")
    if parsed.username or parsed.password or (parsed.port not in (None, 443)):
        raise ValueError("URL contains disallowed credentials or port")
    return value


def safe_headers(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    allowed = {
        "accept-language",
        "cache-control",
        "pragma",
        "referer",
    }
    output: dict[str, str] = {}
    for key, value in raw.items():
        name = str(key).lower()
        if name in allowed and isinstance(value, str) and len(value) <= 2048:
            output[str(key)] = value
    return output


def ensure_bootstrap(timeout_seconds: float) -> None:
    """Prime the persistent session using the exact successful Safari request shape."""
    global bootstrapped
    if bootstrapped:
        return

    response = session.get(HOME_URL, timeout=timeout_seconds, allow_redirects=True)
    validate_url(str(response.url))
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"SpankBang bootstrap returned HTTP {response.status_code}")
    if str(response.headers.get("cf-mitigated", "")).lower() == "challenge":
        raise RuntimeError("SpankBang bootstrap returned a Cloudflare challenge")
    bootstrapped = True


def handle(message: dict[str, Any]) -> dict[str, Any]:
    global bootstrapped

    request_id = message.get("id")
    url = validate_url(message.get("url"))
    timeout_ms = max(1000, min(int(message.get("timeoutMs", 30000)), 45000))
    timeout_seconds = timeout_ms / 1000
    max_bytes = max(
        1024,
        min(int(message.get("maxBytes", 5 * 1024 * 1024)), MAX_BYTES_HARD_LIMIT),
    )

    parsed = urlparse(url)
    is_home = parsed.path in ("", "/") and not parsed.query
    if not is_home:
        ensure_bootstrap(timeout_seconds)

    headers = safe_headers(message.get("headers"))
    if not is_home and not any(key.lower() == "referer" for key in headers):
        headers["Referer"] = HOME_URL

    response = session.get(
        url,
        headers=headers or None,
        timeout=timeout_seconds,
        allow_redirects=True,
    )

    final_url = validate_url(str(response.url))
    body = bytes(response.content)
    if len(body) > max_bytes:
        raise ValueError(f"Response exceeded {max_bytes} bytes")

    selected_headers = {}
    for name in ("content-type", "server", "cf-ray", "cf-mitigated", "location"):
        value = response.headers.get(name)
        if value is not None:
            selected_headers[name] = str(value)

    ok = 200 <= response.status_code < 300
    if is_home and ok and str(response.headers.get("cf-mitigated", "")).lower() != "challenge":
        bootstrapped = True

    return {
        "id": request_id,
        "ok": ok,
        "status": int(response.status_code),
        "finalUrl": final_url,
        "headers": selected_headers,
        "bodyBase64": base64.b64encode(body).decode("ascii"),
    }


for line in sys.stdin:
    message: Any = None
    try:
        message = json.loads(line)
        if not isinstance(message, dict):
            raise ValueError("Request must be a JSON object")
        emit(handle(message))
    except Exception as exc:  # Return a bounded error without cookies or body data.
        request_id = None
        try:
            request_id = message.get("id") if isinstance(message, dict) else None
        except Exception:
            pass
        emit(
            {
                "id": request_id,
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
