#!/usr/bin/env python3
"""Persistent curl_cffi Safari transport for protected provider requests.

The process reads one JSON object per line from stdin and writes one JSON
response per line to stdout. Separate persistent sessions are retained for
SpankBang and JAV HD Porn so cookies and anti-bot state never cross providers.
"""

from __future__ import annotations

import base64
import json
import os
import sys
from typing import Any
from urllib.parse import urlparse

from curl_cffi import requests

PROFILES = {
    "spankbang": {
        "allowed_hosts": {"spankbang.com", "www.spankbang.com"},
        "home_url": "https://spankbang.com/",
        "impersonate": os.getenv("SPANKBANG_IMPERSONATE", "safari"),
        "bootstrap": True,
    },
    "javhdporn": {
        "allowed_hosts": {
            "javhdporn.net",
            "www.javhdporn.net",
            "video.javhdporn.net",
        },
        "home_url": "https://www.javhdporn.net/",
        "impersonate": os.getenv("JAVHDPORN_IMPERSONATE", "safari"),
        "bootstrap": False,
    },
}
MAX_BYTES_HARD_LIMIT = 8 * 1024 * 1024
MAX_BODY_CHARS = 256 * 1024

sessions: dict[str, requests.Session] = {}
bootstrapped: set[str] = set()


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def profile_config(value: Any) -> tuple[str, dict[str, Any]]:
    profile = str(value or "spankbang").lower()
    config = PROFILES.get(profile)
    if not config:
        raise ValueError("Unknown Safari transport profile")
    return profile, config


def session_for(profile: str, config: dict[str, Any]) -> requests.Session:
    session = sessions.get(profile)
    if session is not None:
        return session

    session = requests.Session(impersonate=config["impersonate"])
    if profile == "spankbang":
        for cookie_name, cookie_value in {
            "sb": "1",
            "age_verified": "1",
            "hasVisited": "1",
        }.items():
            session.cookies.set(cookie_name, cookie_value, domain="spankbang.com", path="/")
    sessions[profile] = session
    return session


def validate_url(value: Any, config: dict[str, Any]) -> str:
    if not isinstance(value, str):
        raise ValueError("URL must be a string")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or host not in config["allowed_hosts"]:
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


def ensure_bootstrap(
    profile: str,
    config: dict[str, Any],
    session: requests.Session,
    timeout_seconds: float,
) -> None:
    if profile in bootstrapped:
        return

    response = session.get(
        config["home_url"],
        timeout=timeout_seconds,
        allow_redirects=True,
    )
    validate_url(str(response.url), config)
    if not 200 <= response.status_code < 300:
        raise RuntimeError(f"{profile} bootstrap returned HTTP {response.status_code}")
    if str(response.headers.get("cf-mitigated", "")).lower() == "challenge":
        raise RuntimeError(f"{profile} bootstrap returned a Cloudflare challenge")
    bootstrapped.add(profile)


def cookie_header(session: requests.Session) -> str:
    values = session.cookies.get_dict()
    return "; ".join(f"{name}={value}" for name, value in values.items())


def handle(message: dict[str, Any]) -> dict[str, Any]:
    request_id = message.get("id")
    profile, config = profile_config(message.get("profile"))
    session = session_for(profile, config)
    url = validate_url(message.get("url"), config)
    timeout_ms = max(1000, min(int(message.get("timeoutMs", 30000)), 45000))
    timeout_seconds = timeout_ms / 1000
    max_bytes = max(
        1024,
        min(int(message.get("maxBytes", 5 * 1024 * 1024)), MAX_BYTES_HARD_LIMIT),
    )
    method = str(message.get("method") or "GET").upper()
    if method not in {"GET", "POST", "HEAD"}:
        raise ValueError("Safari transport method is not allowed")

    parsed = urlparse(url)
    home = urlparse(config["home_url"])
    is_home = (
        parsed.hostname == home.hostname
        and parsed.path in ("", "/")
        and not parsed.query
    )
    if not is_home and config.get("bootstrap", False):
        ensure_bootstrap(profile, config, session, timeout_seconds)

    headers = safe_headers(message.get("headers"))
    if not is_home and not any(key.lower() == "referer" for key in headers):
        headers["Referer"] = config["home_url"]

    response = session.request(
        method,
        url,
        headers=headers or None,
        data=safe_body(message.get("data")) if method == "POST" else None,
        timeout=timeout_seconds,
        allow_redirects=True,
    )

    final_url = validate_url(str(response.url), config)
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

    ok = 200 <= response.status_code < 300
    if is_home and ok and str(response.headers.get("cf-mitigated", "")).lower() != "challenge":
        bootstrapped.add(profile)

    return {
        "id": request_id,
        "ok": ok,
        "status": int(response.status_code),
        "finalUrl": final_url,
        "headers": selected_headers,
        "cookieHeader": cookie_header(session),
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
