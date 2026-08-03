#!/usr/bin/env python3
"""Persistent curl_cffi Safari transport for SpankBang page requests.

The process reads one JSON object per line from stdin and writes one JSON
response per line to stdout. Production requests go directly to the requested
catalog/video route. A bounded fresh-session retry is used only when the first
direct request fails or is challenged.
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
DEFAULT_IMPERSONATION = os.getenv("SPANKBANG_IMPERSONATE", "safari")
DEFAULT_ATTEMPTS = max(1, min(int(os.getenv("SPANKBANG_SAFARI_ATTEMPTS", "2")), 3))

BASE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Referer": HOME_URL,
    "Cookie": "sb=1; age_verified=1; hasVisited=1;",
    "Upgrade-Insecure-Requests": "1",
}


def apply_age_cookies(target: requests.Session) -> None:
    for cookie_name, cookie_value in {
        "sb": "1",
        "age_verified": "1",
        "hasVisited": "1",
    }.items():
        target.cookies.set(cookie_name, cookie_value, domain="spankbang.com", path="/")


def new_session() -> requests.Session:
    target = requests.Session(impersonate=DEFAULT_IMPERSONATION)
    apply_age_cookies(target)
    return target


session = requests.Session(impersonate=os.getenv("SPANKBANG_IMPERSONATE", "safari"))
apply_age_cookies(session)
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
    if parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError("URL contains disallowed credentials or port")
    return value


def safe_headers(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    allowed = {
        "accept",
        "accept-language",
        "cache-control",
        "pragma",
        "referer",
        "cookie",
        "upgrade-insecure-requests",
    }
    output: dict[str, str] = {}
    for key, value in raw.items():
        name = str(key).lower()
        if name in allowed and isinstance(value, str) and len(value) <= 4096:
            output[str(key)] = value
    return output


def ensure_bootstrap(timeout_seconds) -> None:
    """Best-effort homepage warmup; the requested route remains authoritative."""
    global bootstrapped
    if bootstrapped:
        return
    try:
        # Compatibility-only probe. Production catalog/video retrieval does not
        # depend on this function; the real requested route is attempted first.
        probe_session = requests.Session(
            impersonate=os.getenv("SPANKBANG_IMPERSONATE", "safari")
        )
        apply_age_cookies(probe_session)
        response = probe_session.get(
            HOME_URL, timeout=timeout_seconds, allow_redirects=True
        )
        validate_url(str(response.url))
        challenged = (
            str(response.headers.get("cf-mitigated", "")).lower() == "challenge"
        )
        if 200 <= response.status_code < 300 and not challenged:
            bootstrapped = True
    except Exception:
        # Cloudflare may challenge the homepage while allowing the real catalog/video route.
        return


def response_headers(response: Any, used_attempts: int) -> dict[str, str]:
    selected: dict[str, str] = {}
    for name in ("content-type", "server", "cf-ray", "cf-mitigated", "location"):
        value = response.headers.get(name)
        if value is not None:
            selected[name] = str(value)
    selected["x-spankbang-impersonation"] = DEFAULT_IMPERSONATION
    selected["x-spankbang-attempts"] = str(used_attempts)
    return selected


def handle(message: dict[str, Any]) -> dict[str, Any]:
    global session, bootstrapped

    request_id = message.get("id")
    url = validate_url(message.get("url"))
    timeout_ms = max(1000, min(int(message.get("timeoutMs", 30000)), 45000))
    max_bytes = max(
        1024,
        min(int(message.get("maxBytes", 5 * 1024 * 1024)), MAX_BYTES_HARD_LIMIT),
    )
    attempts = max(1, min(int(message.get("attempts", DEFAULT_ATTEMPTS)), 3))
    per_attempt_timeout = max(1.0, (timeout_ms / 1000.0) / attempts)
    headers = {**BASE_HEADERS, **safe_headers(message.get("headers"))}
    if not any(key.lower() == "referer" for key in headers):
        headers["Referer"] = HOME_URL

    last_response = None
    last_error = ""
    used_attempts = 0

    for attempt in range(1, attempts + 1):
        used_attempts = attempt
        if attempt > 1:
            session = new_session()
        try:
            response = session.get(
                url,
                headers=headers,
                timeout=per_attempt_timeout,
                allow_redirects=True,
            )
            last_response = response
            final_url = validate_url(str(response.url))
            challenged = (
                str(response.headers.get("cf-mitigated", "")).lower() == "challenge"
            )
            ok = 200 <= response.status_code < 300 and not challenged
            if ok:
                # A successful real route proves the persistent session is usable even when
                # the homepage warmup was challenged.
                bootstrapped = True
                body = bytes(response.content)
                if len(body) > max_bytes:
                    raise ValueError(f"Response exceeded {max_bytes} bytes")
                return {
                    "id": request_id,
                    "ok": True,
                    "status": int(response.status_code),
                    "finalUrl": final_url,
                    "headers": response_headers(response, used_attempts),
                    "bodyBase64": base64.b64encode(body).decode("ascii"),
                }
            last_error = f"HTTP {response.status_code}"
        except Exception as exc:
            last_error = str(exc)

    status = int(last_response.status_code) if last_response is not None else 0
    return {
        "id": request_id,
        "ok": False,
        "status": status,
        "finalUrl": str(last_response.url) if last_response is not None else url,
        "headers": response_headers(last_response, used_attempts) if last_response is not None else {
            "x-spankbang-impersonation": DEFAULT_IMPERSONATION,
            "x-spankbang-attempts": str(used_attempts),
        },
        "error": last_error or f"HTTP {status or 'unknown'}",
        "bodyBase64": "",
    }


for line in sys.stdin:
    message: Any = None
    try:
        message = json.loads(line)
        if not isinstance(message, dict):
            raise ValueError("Request must be a JSON object")
        emit(handle(message))
    except Exception as exc:
        request_id = message.get("id") if isinstance(message, dict) else None
        emit(
            {
                "id": request_id,
                "ok": False,
                "status": 0,
                "headers": {},
                "error": str(exc)[:500],
                "bodyBase64": "",
            }
        )
