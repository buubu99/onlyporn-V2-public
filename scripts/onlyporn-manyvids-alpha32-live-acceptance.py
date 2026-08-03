#!/usr/bin/env python3
from __future__ import annotations

import concurrent.futures
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LIVE = os.environ.get(
    "LIVE_BASE_URL",
    "https://onlyporn-v2-public-k143.onrender.com",
).rstrip("/")
BASELINE = Path(os.environ["BASELINE_DIR"])
OUT = Path(os.environ["ACCEPTANCE_OUT"])
EXPECTED_VERSION = os.environ.get("EXPECTED_VERSION", "2.7.0-alpha.32")
TARGET_MIN_RATIO = float(os.environ.get("TARGET_MIN_RATIO", "0.60"))
RETENTION_MIN_RATIO = float(os.environ.get("RETENTION_MIN_RATIO", "0.90"))
CONCURRENCY = max(1, int(os.environ.get("ACCEPTANCE_CONCURRENCY", "3")))
UA = "OnlyPorn-alpha32-live-acceptance/1.0"

TARGETS = [
    ("tpb4k.tpdb.recent", "ThePornDB Recent"),
    ("tpb4k.studio.xvideosred.top", "XVideosRED"),
]
CONTROLS = [
    ("tpb4k.studio.digitalplayground.top", "DigitalPlayground"),
    ("tpb4k.studio.dorcelclub.top", "DorcelClub"),
    ("tpb4k.studio.onlyfans.top", "OnlyFans"),
]
YESPORN = "tpb4k.yesporn.recent"
SPANKBANG = "spankbang"


def request(url: str, *, range_header: str = "", timeout: int = 90):
    headers = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Cache-Control": "no-cache",
    }
    if range_header:
        headers["Range"] = range_header
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=headers, method="GET")
            return urllib.request.urlopen(req, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise last


def get_json(url: str):
    with request(url) as response:
        return json.loads(response.read(16 * 1024 * 1024).decode("utf-8"))


def catalog_url(catalog_id: str):
    return f"{LIVE}/catalog/movie/{urllib.parse.quote(catalog_id, safe='')}.json"


def stream_url(item_id: str):
    return f"{LIVE}/stream/movie/{urllib.parse.quote(item_id, safe='')}.json"


def fetch_catalog(catalog_id: str):
    payload = get_json(catalog_url(catalog_id))
    metas = payload.get("metas", []) if isinstance(payload, dict) else []
    return metas if isinstance(metas, list) else []


def probe_relay(url: str):
    parsed = urllib.parse.urlparse(url)
    live = urllib.parse.urlparse(LIVE)
    if (
        parsed.scheme != "https"
        or parsed.hostname != live.hostname
        or not parsed.path.startswith("/media/")
    ):
        return False, "not an OnlyPorn relay"
    try:
        with request(url, range_header="bytes=0-65535", timeout=75) as response:
            status = int(response.status)
            content_type = str(response.headers.get("content-type", "")).lower()
            body = response.read(65536)
        valid = status in (200, 206) and (
            b"ftyp" in body[:512]
            or content_type.startswith("video/mp4")
            or "mpegurl" in content_type
        )
        return valid, f"HTTP {status} {content_type}"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


def test_target_card(meta: dict):
    item_id = str(meta.get("id") or "")
    title = str(meta.get("name") or "")
    try:
        payload = get_json(stream_url(item_id))
        streams = payload.get("streams", []) if isinstance(payload, dict) else []
        if not isinstance(streams, list):
            streams = []
        direct = []
        for stream in streams:
            if not isinstance(stream, dict):
                continue
            url = str(stream.get("url") or "")
            text = " ".join(
                str(stream.get(key) or "")
                for key in ("name", "title", "description")
            )
            if url and "/media/" in url and "manyvids" in text.lower():
                direct.append((url, text))
        for url, text in direct:
            valid, reason = probe_relay(url)
            if valid:
                access = "PREVIEW" if "[PREVIEW]" in text.upper() else "FULL"
                return {
                    "id": item_id,
                    "title": title,
                    "pass": True,
                    "access": access,
                    "streams": len(streams),
                    "reason": reason,
                }
        return {
            "id": item_id,
            "title": title,
            "pass": False,
            "access": "",
            "streams": len(streams),
            "reason": "no byte-valid ManyVids relay",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "id": item_id,
            "title": title,
            "pass": False,
            "access": "",
            "streams": 0,
            "reason": f"{type(exc).__name__}: {exc}",
        }


def test_any_stream(meta: dict):
    item_id = str(meta.get("id") or "")
    try:
        payload = get_json(stream_url(item_id))
        streams = payload.get("streams", []) if isinstance(payload, dict) else []
        return bool(isinstance(streams, list) and streams)
    except Exception:  # noqa: BLE001
        return False


def load_baseline(catalog_id: str):
    path = BASELINE / f"{catalog_id}.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    metas = payload.get("metas", []) if isinstance(payload, dict) else []
    return metas if isinstance(metas, list) else []


manifest = get_json(f"{LIVE}/manifest.json")
version = str(manifest.get("version") or "")
report = {
    "live": LIVE,
    "version": version,
    "expectedVersion": EXPECTED_VERSION,
    "targets": {},
    "controls": {},
    "yesporn": {},
    "spankbang": {},
    "gates": {},
}

targets_pass = True
for catalog_id, label in TARGETS:
    baseline = load_baseline(catalog_id)
    current = fetch_catalog(catalog_id)
    baseline_ids = {str(item.get("id") or "") for item in baseline if item.get("id")}
    current_ids = {str(item.get("id") or "") for item in current if item.get("id")}
    retained = len(baseline_ids & current_ids)
    retention = retained / len(baseline_ids) if baseline_ids else 0.0
    count_gate = len(current) >= max(1, len(baseline) - 2)
    retention_gate = retention >= RETENTION_MIN_RATIO

    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        rows = list(pool.map(test_target_card, current))
    playable = sum(1 for row in rows if row["pass"])
    full = sum(1 for row in rows if row["pass"] and row["access"] == "FULL")
    previews = sum(1 for row in rows if row["pass"] and row["access"] == "PREVIEW")
    ratio = playable / len(current) if current else 0.0
    playback_gate = ratio >= TARGET_MIN_RATIO and playable > 0

    report["targets"][catalog_id] = {
        "label": label,
        "baselineCards": len(baseline),
        "currentCards": len(current),
        "retainedIds": retained,
        "retentionRatio": retention,
        "playable": playable,
        "full": full,
        "previews": previews,
        "playableRatio": ratio,
        "countGate": count_gate,
        "retentionGate": retention_gate,
        "playbackGate": playback_gate,
        "rows": rows,
    }
    targets_pass = targets_pass and count_gate and retention_gate and playback_gate
    print(
        f"{label}: cards {len(baseline)}->{len(current)}, "
        f"retained {retention:.1%}, playable {playable}/{len(current)} "
        f"(full={full}, preview={previews})"
    )

controls_pass = True
for catalog_id, label in CONTROLS:
    cards = fetch_catalog(catalog_id)
    sample = cards[:10]
    with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        results = list(pool.map(test_any_stream, sample))
    working = sum(1 for value in results if value)
    gate = bool(cards) and working >= 1
    report["controls"][catalog_id] = {
        "label": label,
        "cards": len(cards),
        "sample": len(sample),
        "working": working,
        "gate": gate,
    }
    controls_pass = controls_pass and gate
    print(f"{label} control: {working}/{len(sample)} sampled cards returned streams")

spankbang_baseline = load_baseline(SPANKBANG)
spankbang_cards = fetch_catalog(SPANKBANG)
spankbang_minimum = max(1, len(spankbang_baseline) - 2)
spankbang_count_gate = bool(spankbang_baseline) and len(spankbang_cards) >= spankbang_minimum
spankbang_sample = spankbang_cards[:5]
with concurrent.futures.ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
    spankbang_results = list(pool.map(test_any_stream, spankbang_sample))
spankbang_working = sum(1 for value in spankbang_results if value)
spankbang_playback_gate = bool(spankbang_sample) and spankbang_working >= 1
spankbang_gate = spankbang_count_gate
report["spankbang"] = {
    "baselineCards": len(spankbang_baseline),
    "currentCards": len(spankbang_cards),
    "minimumCards": spankbang_minimum,
    "sample": len(spankbang_sample),
    "working": spankbang_working,
    "countGate": spankbang_count_gate,
    "playbackGate": spankbang_playback_gate,
    "gate": spankbang_gate,
    "note": "playback sample is diagnostic; the alpha.31 fix is catalog retrieval",
}
print(
    f"SpankBang protected alpha.31 control: cards "
    f"{len(spankbang_baseline)}->{len(spankbang_cards)}, "
    f"streams {spankbang_working}/{len(spankbang_sample)}"
)

yesporn_cards = fetch_catalog(YESPORN)
yesporn_sample = yesporn_cards[:10]
yesporn_results = []
for meta in yesporn_sample:
    item_id = str(meta.get("id") or "")
    try:
        payload = get_json(stream_url(item_id))
        streams = payload.get("streams", []) if isinstance(payload, dict) else []
        passed = False
        reason = "no relayed stream"
        for stream in streams if isinstance(streams, list) else []:
            url = str(stream.get("url") or "") if isinstance(stream, dict) else ""
            if not url:
                continue
            passed, reason = probe_relay(url)
            if passed:
                break
        yesporn_results.append({"id": item_id, "pass": passed, "reason": reason})
    except Exception as exc:  # noqa: BLE001
        yesporn_results.append(
            {
                "id": item_id,
                "pass": False,
                "reason": f"{type(exc).__name__}: {exc}",
            }
        )
yesporn_playable = sum(1 for row in yesporn_results if row["pass"])
yesporn_gate = bool(yesporn_sample) and yesporn_playable >= max(1, len(yesporn_sample) - 2)
report["yesporn"] = {
    "cards": len(yesporn_cards),
    "sample": len(yesporn_sample),
    "playable": yesporn_playable,
    "gate": yesporn_gate,
    "rows": yesporn_results,
}
print(f"YesPorn protected control: {yesporn_playable}/{len(yesporn_sample)} byte-valid")

version_gate = version == EXPECTED_VERSION
overall = (
    version_gate
    and targets_pass
    and controls_pass
    and spankbang_gate
    and yesporn_gate
)
report["gates"] = {
    "version": version_gate,
    "targets": targets_pass,
    "controls": controls_pass,
    "spankbang": spankbang_gate,
    "yesporn": yesporn_gate,
    "overall": overall,
}

OUT.write_text(
    json.dumps(report, indent=2, ensure_ascii=False) + "\n",
    encoding="utf-8",
)
print(f"Acceptance report: {OUT}")
print(f"OVERALL: {'PASS' if overall else 'FAIL'}")
sys.exit(0 if overall else 3)
