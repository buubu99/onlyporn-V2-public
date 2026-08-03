#!/usr/bin/env python3
from __future__ import annotations

import base64
import concurrent.futures
import json
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

LIVE = os.environ.get(
    "LIVE_BASE_URL",
    "https://onlyporn-v2-public-k143.onrender.com",
).rstrip("/")
BASELINE = Path(os.environ["BASELINE_DIR"])
OUT = Path(os.environ["ACCEPTANCE_OUT"])
EXPECTED_VERSION = os.environ.get("EXPECTED_VERSION", "2.7.0-alpha.33")
UA = "OnlyPorn-alpha33-authoritative-direct-uuid-live-acceptance/1.0"
HEAD_BYTES = 1024 * 1024
TAIL_BYTES = 4 * 1024 * 1024

TARGETS = [
    ("tpb4k.tpdb.recent", "ThePornDB Recent"),
    ("tpb4k.studio.xvideosred.top", "XVideosRED"),
]
PROOF_UUIDS_BY_CATALOG = {
    "tpb4k.tpdb.recent": [
        "17424e20-1857-432e-844d-bbbd00eb455f",
        "3392f14d-4282-43ea-8be3-07b36173964b",
        "69ba4477-be83-4021-b834-e804e773abdf",
    ],
    "tpb4k.studio.xvideosred.top": [
        "17d8775a-7a2f-45e8-8627-2f53d7da50bf",
        "69ba4477-be83-4021-b834-e804e773abdf",
    ],
}
KNOWN_FULL_UUID = "69ba4477-be83-4021-b834-e804e773abdf"


def clean(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def encode_direct_id(uuid: str, catalog_id: str) -> str:
    # Exact equivalent of encodeTpb4kId legacy version 1:
    # {v:1,s:"tpdb",i:"tpdb:<uuid>",c:"<catalog>"}
    payload = {
        "v": 1,
        "s": "tpdb",
        "i": f"tpdb:{uuid}",
        "c": catalog_id,
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return f"onlyporn:tpb4k:{encoded}"


def request_bytes(url: str, range_header: str | None = None, limit: int = HEAD_BYTES, timeout: int = 120):
    headers = {
        "User-Agent": UA,
        "Accept": "video/mp4,application/octet-stream,*/*",
        "Cache-Control": "no-cache",
    }
    if range_header:
        headers["Range"] = range_header
    request = urllib.request.Request(url, headers=headers, method="GET")
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read(limit)
                return {
                    "status": int(getattr(response, "status", 200)),
                    "body": body,
                    "headers": {key.lower(): value for key, value in response.headers.items()},
                    "finalUrl": response.geturl(),
                }
        except Exception as exc:
            last = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise last


def get_json(url: str, timeout: int = 120):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Cache-Control": "no-cache",
        },
        method="GET",
    )
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read(16 * 1024 * 1024).decode("utf-8"))
        except Exception as exc:
            last = exc
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    raise last


def parse_mvhd_duration(data: bytes) -> float:
    best = 0.0
    for marker in (b"mvhd", b"mdhd"):
        offset = 0
        while True:
            index = data.find(marker, offset)
            if index < 0:
                break
            box_start = index - 4
            try:
                if box_start >= 0 and index + 24 <= len(data):
                    box_size = struct.unpack_from(">I", data, box_start)[0]
                    version = data[index + 4]
                    if version == 0 and box_size >= 28:
                        timescale = struct.unpack_from(">I", data, index + 16)[0]
                        duration = struct.unpack_from(">I", data, index + 20)[0]
                        if timescale and duration:
                            best = max(best, duration / timescale)
                    if version == 1 and box_size >= 40 and index + 36 <= len(data):
                        timescale = struct.unpack_from(">I", data, index + 24)[0]
                        duration = struct.unpack_from(">Q", data, index + 28)[0]
                        if timescale and duration:
                            best = max(best, duration / timescale)
            except (IndexError, struct.error):
                pass
            offset = index + 4
        if marker == b"mvhd" and best > 0:
            return best
    return best


def total_size(headers: dict[str, str], status: int) -> int:
    match = re.search(r"/(\d+)\s*$", clean(headers.get("content-range")))
    if match:
        return int(match.group(1))
    if status == 200:
        try:
            return int(headers.get("content-length", "0"))
        except ValueError:
            return 0
    return 0


def parse_clock(value: str) -> float:
    parts = value.split(":")
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return 0.0
    if len(numbers) == 2:
        return numbers[0] * 60 + numbers[1]
    if len(numbers) == 3:
        return numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
    return 0.0


def probe_relay(url: str, text: str) -> dict[str, Any]:
    try:
        head = request_bytes(url, f"bytes=0-{HEAD_BYTES - 1}", HEAD_BYTES)
        status = head["status"]
        headers = head["headers"]
        content_type = clean(headers.get("content-type")).lower()
        has_ftyp = b"ftyp" in head["body"][:512]
        if status not in (200, 206) or not (
            has_ftyp or content_type.startswith("video/mp4") or content_type == "application/octet-stream"
        ):
            return {"valid": False, "reason": "not-mp4", "status": status, "durationSeconds": 0}
        duration = parse_mvhd_duration(head["body"])
        size = total_size(headers, status)
        if not duration:
            tail_range = (
                f"bytes={max(size - TAIL_BYTES, 0)}-{size - 1}"
                if size > 0
                else f"bytes=-{TAIL_BYTES}"
            )
            tail = request_bytes(url, tail_range, TAIL_BYTES)
            duration = parse_mvhd_duration(tail["body"])
            size = size or total_size(tail["headers"], tail["status"])
        expected_match = re.search(r"\[FULL\s+(\d+(?::\d+){1,2})\]", text, flags=re.I)
        expected = parse_clock(expected_match.group(1)) if expected_match else 0.0
        valid = duration >= 12 and (expected <= 0 or duration >= expected * 0.80)
        return {
            "valid": valid,
            "reason": "duration-verified" if valid else "short-or-duration-mismatch",
            "status": status,
            "durationSeconds": duration,
            "expectedLabelSeconds": expected,
            "contentLength": size,
        }
    except Exception as exc:
        return {
            "valid": False,
            "reason": f"{type(exc).__name__}: {exc}",
            "status": 0,
            "durationSeconds": 0,
        }


def catalog(catalog_id: str):
    payload = get_json(f"{LIVE}/catalog/movie/{urllib.parse.quote(catalog_id, safe='')}.json")
    metas = payload.get("metas", []) if isinstance(payload, dict) else []
    return metas if isinstance(metas, list) else []


def inspect_stream_id(item_id: str, uuid: str, title: str = ""):
    payload = get_json(f"{LIVE}/stream/movie/{urllib.parse.quote(item_id, safe='')}.json")
    streams = payload.get("streams", []) if isinstance(payload, dict) else []
    streams = streams if isinstance(streams, list) else []
    previews = []
    full = []
    for stream in streams:
        if not isinstance(stream, dict):
            continue
        text = " ".join(clean(stream.get(key)) for key in ("name", "title", "description"))
        url = clean(stream.get("url"))
        if "manyvids" in text.lower() and re.search(r"preview|teaser", text, flags=re.I):
            previews.append({"text": text, "hasUrl": bool(url)})
        if "manyvids" in text.lower() and "[full" in text.lower():
            proof = probe_relay(url, text) if url else {
                "valid": False,
                "reason": "missing-relay-url",
                "durationSeconds": 0,
            }
            full.append({"text": text, "hasUrl": bool(url), "proof": proof})
    return {
        "uuid": uuid,
        "id": item_id,
        "title": title,
        "streamCount": len(streams),
        "previewStreams": previews,
        "fullStreams": full,
    }


def inspect_direct_uuid(catalog_id: str, uuid: str):
    return inspect_stream_id(
        encode_direct_id(uuid, catalog_id),
        uuid,
        f"direct TPDB UUID {uuid}",
    )


def inspect_current_labels(meta: dict[str, Any]):
    item_id = clean(meta.get("id"))
    try:
        payload = get_json(f"{LIVE}/stream/movie/{urllib.parse.quote(item_id, safe='')}.json")
        streams = payload.get("streams", []) if isinstance(payload, dict) else []
        streams = streams if isinstance(streams, list) else []
        preview_labels = []
        for stream in streams:
            if not isinstance(stream, dict):
                continue
            text = " ".join(clean(stream.get(key)) for key in ("name", "title", "description"))
            if "manyvids" in text.lower() and re.search(r"preview|teaser", text, flags=re.I):
                preview_labels.append(text)
        return {
            "id": item_id,
            "title": clean(meta.get("name")),
            "previewLabels": preview_labels,
        }
    except Exception as exc:
        return {
            "id": item_id,
            "title": clean(meta.get("name")),
            "previewLabels": [],
            "error": f"{type(exc).__name__}: {exc}",
        }


def sample_control(catalog_id: str):
    metas = catalog(catalog_id)
    for meta in metas[:5]:
        try:
            item_id = clean(meta.get("id"))
            payload = get_json(f"{LIVE}/stream/movie/{urllib.parse.quote(item_id, safe='')}.json")
            streams = payload.get("streams", []) if isinstance(payload, dict) else []
            if isinstance(streams, list) and streams:
                return {"cards": len(metas), "streamFound": True}
        except Exception:
            continue
    return {"cards": len(metas), "streamFound": False}


manifest_payload = get_json(f"{LIVE}/manifest.json")
version = clean(manifest_payload.get("version"))
report: dict[str, Any] = {
    "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "live": LIVE,
    "version": version,
    "expectedVersion": EXPECTED_VERSION,
    "proofMode": "direct-generated-tpb4k-ids-not-catalog-membership",
    "targets": {},
}

targets_gate = True
for catalog_id, label in TARGETS:
    baseline_payload = json.loads((BASELINE / f"{catalog_id}.json").read_text(encoding="utf-8"))
    old = baseline_payload.get("metas", []) if isinstance(baseline_payload, dict) else []
    old = old if isinstance(old, list) else []
    current = catalog(catalog_id)
    old_ids = {clean(item.get("id")) for item in old if isinstance(item, dict) and item.get("id")}
    current_ids = {clean(item.get("id")) for item in current if isinstance(item, dict) and item.get("id")}
    retention = len(old_ids & current_ids) / len(old_ids) if old_ids else 0.0

    proof_uuids = PROOF_UUIDS_BY_CATALOG[catalog_id]
    rows = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures = {
            pool.submit(inspect_direct_uuid, catalog_id, uuid): uuid
            for uuid in proof_uuids
        }
        for future in concurrent.futures.as_completed(futures):
            uuid = futures[future]
            try:
                rows.append(future.result())
            except Exception as exc:
                rows.append({
                    "uuid": uuid,
                    "title": f"direct TPDB UUID {uuid}",
                    "streamCount": 0,
                    "previewStreams": [],
                    "fullStreams": [],
                    "error": f"{type(exc).__name__}: {exc}",
                })

    current_sample = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        current_sample = list(pool.map(inspect_current_labels, current[:10]))

    preview_count = sum(len(row.get("previewStreams", [])) for row in rows)
    sample_preview_count = sum(len(row.get("previewLabels", [])) for row in current_sample)
    valid_full_rows = [
        row for row in rows
        if any(stream.get("proof", {}).get("valid") for stream in row.get("fullStreams", []))
    ]
    invalid_full = sum(
        1
        for row in rows
        for stream in row.get("fullStreams", [])
        if not stream.get("proof", {}).get("valid")
    )
    known_full = next((row for row in rows if row.get("uuid") == KNOWN_FULL_UUID), None)
    known_full_valid = bool(
        known_full and any(
            stream.get("proof", {}).get("valid")
            for stream in known_full.get("fullStreams", [])
        )
    )
    preview_only_unexpected_full = sum(
        1
        for row in rows
        if row.get("uuid") != KNOWN_FULL_UUID and row.get("fullStreams")
    )
    proof_errors = [row.get("error") for row in rows if row.get("error")]

    gate = (
        len(current) >= max(1, len(old) - 2)
        and retention >= 0.90
        and not proof_errors
        and preview_count == 0
        and sample_preview_count == 0
        and invalid_full == 0
        and known_full_valid
        and preview_only_unexpected_full == 0
    )
    targets_gate = targets_gate and gate
    report["targets"][catalog_id] = {
        "label": label,
        "baselineCards": len(old),
        "currentCards": len(current),
        "retentionRatio": retention,
        "directProofRows": rows,
        "currentSample": current_sample,
        "directPreviewStreams": preview_count,
        "currentSamplePreviewLabels": sample_preview_count,
        "durationVerifiedFullRows": len(valid_full_rows),
        "invalidFullStreams": invalid_full,
        "knownFullValid": known_full_valid,
        "previewOnlyUnexpectedFull": preview_only_unexpected_full,
        "proofErrors": proof_errors,
        "gate": gate,
    }
    print(
        f"{label}: cards {len(old)}->{len(current)}, retained={retention:.1%}, "
        f"direct-preview={preview_count}, sample-preview={sample_preview_count}, "
        f"verified-full={len(valid_full_rows)}, invalid-full={invalid_full}, "
        f"known-full={known_full_valid}, preview-only-full={preview_only_unexpected_full} "
        f"=> {'PASS' if gate else 'FAIL'}"
    )

spankbang_baseline_payload = json.loads((BASELINE / "spankbang.json").read_text(encoding="utf-8"))
spankbang_old = spankbang_baseline_payload.get("metas", []) if isinstance(spankbang_baseline_payload, dict) else []
spankbang_now = catalog("spankbang")
spankbang_gate = len(spankbang_now) >= max(1, len(spankbang_old) - 2)
yesporn_control = sample_control("tpb4k.yesporn.recent")
yesporn_gate = yesporn_control["cards"] > 0 and yesporn_control["streamFound"]
controls_gate = spankbang_gate and yesporn_gate

version_gate = version == EXPECTED_VERSION
overall = version_gate and targets_gate and controls_gate
report["controls"] = {
    "spankbangBaselineCards": len(spankbang_old),
    "spankbangCurrentCards": len(spankbang_now),
    "spankbangGate": spankbang_gate,
    "yesporn": yesporn_control,
    "yespornGate": yesporn_gate,
    "gate": controls_gate,
}
report["gates"] = {
    "version": version_gate,
    "targets": targets_gate,
    "controls": controls_gate,
    "overall": overall,
}
OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Acceptance report: {OUT}")
print(f"OVERALL: {'PASS' if overall else 'FAIL'}")
sys.exit(0 if overall else 3)
