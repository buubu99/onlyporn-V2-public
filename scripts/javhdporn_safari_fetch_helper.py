#!/usr/bin/env python3
"""Persistent curl_cffi Safari transport dedicated to JAV HD Porn.

The process reads one JSON object per line from stdin and writes one JSON
response per line to stdout. It handles only JAVHDPorn, so cookies and
anti-bot state cannot cross provider boundaries.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
from typing import Any
from urllib.parse import urlparse

from curl_cffi import requests

ALLOWED_HOSTS = {
    "javhdporn.net",
    "www.javhdporn.net",
    "video.javhdporn.net",
}
ALLOWED_HOST_PATTERN = re.compile(r"^video\d*\.javhdporn\.net$")
HOME_URL = "https://www.javhdporn.net/"
MAX_BYTES_HARD_LIMIT = 8 * 1024 * 1024
MAX_BODY_CHARS = 256 * 1024

session = requests.Session(
    impersonate=os.getenv("JAVHDPORN_IMPERSONATE", "safari")
)


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def validate_url(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("URL must be a string")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    allowed = host in ALLOWED_HOSTS or bool(ALLOWED_HOST_PATTERN.fullmatch(host))
    if parsed.scheme != "https" or not allowed:
        raise ValueError("URL host is not approved for JAVHDPorn Safari transport")
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
        "content-type",
        "origin",
        "pragma",
        "referer",
        "x-requested-with",
    }
    output: dict[str, str] = {}
    for key, value in raw.items():
        name = str(key).lower()
        if name in allowed and isinstance(value, str) and len(value) <= 2048:
            output[str(key)] = value
    return output


def safe_body(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("Request body must be a string")
    if len(value) > MAX_BODY_CHARS:
        raise ValueError("Request body is too large")
    return value


def cookie_header() -> str:
    values = session.cookies.get_dict()
    return "; ".join(f"{name}={value}" for name, value in values.items())


def handle(message: dict[str, Any]) -> dict[str, Any]:
    request_id = message.get("id")
    url = validate_url(message.get("url"))
    timeout_ms = max(1000, min(int(message.get("timeoutMs", 30000)), 45000))
    timeout_seconds = timeout_ms / 1000
    max_bytes = max(
        1024,
        min(int(message.get("maxBytes", 5 * 1024 * 1024)), MAX_BYTES_HARD_LIMIT),
    )
    method = str(message.get("method") or "GET").upper()
    if method not in {"GET", "POST", "HEAD"}:
        raise ValueError("Safari transport method is not allowed")

    headers = safe_headers(message.get("headers"))
    if not any(key.lower() == "referer" for key in headers):
        headers["Referer"] = HOME_URL

    response = session.request(
        method,
        url,
        headers=headers or None,
        data=safe_body(message.get("data")) if method == "POST" else None,
        timeout=timeout_seconds,
        allow_redirects=True,
    )

    final_url = validate_url(str(response.url))
    body = bytes(response.content)
    if len(body) > max_bytes:
        raise ValueError(f"Response exceeded {max_bytes} bytes")

    selected_headers = {}
    for name in (
        "content-type",
        "server",
        "cf-ray",
        "cf-mitigated",
        "location",
    ):
        value = response.headers.get(name)
        if value is not None:
            selected_headers[name] = str(value)

    return {
        "id": request_id,
        "ok": 200 <= response.status_code < 300,
        "status": int(response.status_code),
        "finalUrl": final_url,
        "headers": selected_headers,
        "cookieHeader": cookie_header(),
        "bodyBase64": base64.b64encode(body).decode("ascii"),
    }


for line in sys.stdin:
    message: Any = None
    try:
        message = json.loads(line)
        if not isinstance(message, dict):
            raise ValueError("Request must be a JSON object")
        emit(handle(message))
    except Exception as exc:
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
