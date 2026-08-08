#!/usr/bin/env python3
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: sukebei-hentai-sqlite-worker.py <db-path>")

db_path = Path(sys.argv[1]).resolve()
db_path.parent.mkdir(parents=True, exist_ok=True)
try:
    os.chmod(db_path.parent, 0o700)
except OSError:
    pass

hard_max = max(
    int(os.environ.get("ONLYPORN_SUKEBEI_HENTAI_DB_MAX_BYTES", str(512 * 1024 * 1024))),
    16 * 1024 * 1024,
)
min_free = max(
    int(os.environ.get("ONLYPORN_SUKEBEI_HENTAI_MIN_FREE_BYTES", str(4 * 1024 * 1024 * 1024))),
    64 * 1024 * 1024,
)
item_ttl = max(
    int(os.environ.get("ONLYPORN_SUKEBEI_HENTAI_ITEM_TTL_MS", str(30 * 24 * 60 * 60 * 1000))),
    24 * 60 * 60 * 1000,
)
metadata_ttl = max(
    int(os.environ.get("ONLYPORN_SUKEBEI_HENTAI_METADATA_TTL_MS", str(7 * 24 * 60 * 60 * 1000))),
    60 * 60 * 1000,
)

new_db = not db_path.exists()
conn = sqlite3.connect(str(db_path), timeout=5.0, isolation_level=None)
conn.execute("PRAGMA busy_timeout=5000")
if new_db:
    conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA synchronous=NORMAL")
conn.execute("PRAGMA temp_store=FILE")
conn.execute("PRAGMA mmap_size=0")
conn.execute("PRAGMA cache_size=-2048")
conn.execute("PRAGMA wal_autocheckpoint=500")
conn.executescript(
    """
CREATE TABLE IF NOT EXISTS catalog_items (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  search_text TEXT NOT NULL,
  sort_date INTEGER NOT NULL,
  seeders INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_items_kind_sort
  ON catalog_items(kind, sort_date DESC, seeders DESC);
CREATE INDEX IF NOT EXISTS catalog_items_parent
  ON catalog_items(parent_id, kind);
CREATE INDEX IF NOT EXISTS catalog_items_expiry
  ON catalog_items(expires_at);

CREATE TABLE IF NOT EXISTS releases (
  info_hash TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  episode INTEGER NOT NULL,
  title TEXT NOT NULL,
  release_json TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(info_hash, parent_id, episode)
);
CREATE INDEX IF NOT EXISTS releases_parent_episode
  ON releases(parent_id, episode, seen_at DESC);
CREATE INDEX IF NOT EXISTS releases_expiry
  ON releases(expires_at);

CREATE TABLE IF NOT EXISTS metadata_cache (
  provider TEXT NOT NULL,
  query_key TEXT NOT NULL,
  result_json TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(provider, query_key)
);
CREATE INDEX IF NOT EXISTS metadata_expiry
  ON metadata_cache(expires_at);

CREATE TABLE IF NOT EXISTS build_state (
  state_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
"""
)
try:
    os.chmod(db_path, 0o600)
except OSError:
    pass


def now_ms():
    return int(time.time() * 1000)


def db_bytes():
    total = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            total += Path(str(db_path) + suffix).stat().st_size
        except OSError:
            pass
    return total


def can_write():
    try:
        return shutil.disk_usage(str(db_path.parent)).free >= min_free
    except OSError:
        return True


def decode_object(body):
    try:
        value = json.loads(body)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def prune():
    now = now_ms()
    conn.execute("DELETE FROM catalog_items WHERE expires_at < ?", (now,))
    conn.execute("DELETE FROM releases WHERE expires_at < ?", (now,))
    conn.execute("DELETE FROM metadata_cache WHERE expires_at < ?", (now,))
    for _ in range(16):
        if db_bytes() <= hard_max:
            break
        before = conn.total_changes
        conn.execute(
            "DELETE FROM releases WHERE rowid IN "
            "(SELECT rowid FROM releases ORDER BY seen_at ASC LIMIT 1000)"
        )
        if conn.total_changes == before:
            conn.execute(
                "DELETE FROM metadata_cache WHERE rowid IN "
                "(SELECT rowid FROM metadata_cache ORDER BY saved_at ASC LIMIT 100)"
            )
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA incremental_vacuum(256)")
    return {
        "dbBytes": db_bytes(),
        "seriesRows": int(
            conn.execute("SELECT COUNT(*) FROM catalog_items WHERE kind='series'").fetchone()[0]
        ),
        "episodeRows": int(
            conn.execute("SELECT COUNT(*) FROM catalog_items WHERE kind='episode'").fetchone()[0]
        ),
        "releaseRows": int(conn.execute("SELECT COUNT(*) FROM releases").fetchone()[0]),
        "metadataRows": int(conn.execute("SELECT COUNT(*) FROM metadata_cache").fetchone()[0]),
    }


def row_payload(value, kind):
    if not isinstance(value, dict):
        return None
    source_id = str(value.get("sourceId") or "")[:512]
    title = " ".join(str(value.get("title") or "").split())[:500]
    parent_id = str(value.get("parentId") or source_id)[:512]
    if not source_id or not title or not parent_id:
        return None
    search_text = " ".join(str(value.get("searchText") or title).split())[:12000]
    sort_date = int(value.get("sortDate") or 0)
    seeders = max(int(value.get("seeders") or 0), 0)
    item = value.get("item")
    if not isinstance(item, dict):
        return None
    return (
        source_id,
        kind,
        parent_id,
        title,
        search_text,
        sort_date,
        seeders,
        json.dumps(item, separators=(",", ":"), ensure_ascii=False),
    )


def replace_index(payload):
    if not can_write():
        return {"written": False, "reason": "low-free-space"}
    if db_bytes() > hard_max:
        prune()
    if db_bytes() > hard_max:
        return {"written": False, "reason": "hard-max"}
    series = payload.get("seriesItems") or []
    episodes = payload.get("episodeItems") or []
    releases = payload.get("releases") or []
    build = payload.get("build") or {}
    now = now_ms()
    expires = now + item_ttl
    item_rows = []
    for value in series[:500]:
        row = row_payload(value, "series")
        if row:
            item_rows.append(row + (now, expires))
    for value in episodes[:5000]:
        row = row_payload(value, "episode")
        if row:
            item_rows.append(row + (now, expires))
    release_rows = []
    for value in releases[:10000]:
        if not isinstance(value, dict):
            continue
        info_hash = str(value.get("infoHash") or "").lower()
        parent_id = str(value.get("parentId") or "")[:512]
        episode = max(int(value.get("episode") or 0), 0)
        title = " ".join(str(value.get("title") or "").split())[:1000]
        release = value.get("release")
        if len(info_hash) != 40 or not parent_id or not title or not isinstance(release, dict):
            continue
        release_rows.append(
            (
                info_hash,
                parent_id,
                episode,
                title,
                json.dumps(release, separators=(",", ":"), ensure_ascii=False),
                now,
                expires,
            )
        )
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM catalog_items")
        conn.execute("DELETE FROM releases")
        conn.executemany(
            """INSERT INTO catalog_items(
              source_id,kind,parent_id,title,search_text,sort_date,seeders,item_json,updated_at,expires_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            item_rows,
        )
        conn.executemany(
            """INSERT INTO releases(
              info_hash,parent_id,episode,title,release_json,seen_at,expires_at
            ) VALUES(?,?,?,?,?,?,?)""",
            release_rows,
        )
        conn.execute(
            """INSERT INTO build_state(state_key,value_json,updated_at)
               VALUES('catalog',?,?)""",
            (json.dumps(build, separators=(",", ":"), ensure_ascii=False), now),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    stats = prune()
    stats.update(
        {
            "written": True,
            "seriesWritten": len([row for row in item_rows if row[1] == "series"]),
            "episodesWritten": len([row for row in item_rows if row[1] == "episode"]),
            "releasesWritten": len(release_rows),
        }
    )
    return stats


def handle(message):
    operation = str(message.get("op") or "")
    payload = message.get("payload") or {}
    now = now_ms()
    if operation == "ping":
        return {"dbPath": str(db_path)}
    if operation == "stats":
        stats = prune()
        stats.update({"dbPath": str(db_path), "hardMaxBytes": hard_max, "minFreeBytes": min_free})
        return stats
    if operation == "replace_index":
        return replace_index(payload)
    if operation == "list_series":
        limit = min(max(int(payload.get("limit") or 100), 1), 500)
        offset = min(max(int(payload.get("offset") or 0), 0), 10000)
        tokens = [" ".join(str(value or "").lower().split()) for value in (payload.get("tokens") or [])]
        tokens = [value for value in tokens if value][:12]
        where = ["kind='series'", "expires_at>=?"]
        params = [now]
        for token in tokens:
            where.append("lower(search_text) LIKE ? ESCAPE '\\'")
            params.append("%" + token.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%")
        params.extend([limit, offset])
        rows = conn.execute(
            "SELECT item_json FROM catalog_items WHERE "
            + " AND ".join(where)
            + " ORDER BY sort_date DESC,seeders DESC,title ASC LIMIT ? OFFSET ?",
            params,
        ).fetchall()
        return [item for (body,) in rows if (item := decode_object(body)) is not None]
    if operation == "get_item":
        source_id = str(payload.get("sourceId") or "")
        row = conn.execute(
            "SELECT item_json FROM catalog_items WHERE source_id=? AND expires_at>=?",
            (source_id, now),
        ).fetchone()
        return decode_object(row[0]) if row else None
    if operation == "get_metadata":
        provider = str(payload.get("provider") or "")
        query_key = str(payload.get("queryKey") or "")
        row = conn.execute(
            "SELECT result_json,expires_at FROM metadata_cache WHERE provider=? AND query_key=?",
            (provider, query_key),
        ).fetchone()
        if not row:
            return None
        if int(row[1]) < now:
            conn.execute(
                "DELETE FROM metadata_cache WHERE provider=? AND query_key=?",
                (provider, query_key),
            )
            return None
        try:
            return json.loads(row[0])
        except Exception:
            return None
    if operation == "put_metadata":
        if not can_write():
            return {"written": False, "reason": "low-free-space"}
        provider = str(payload.get("provider") or "")[:40]
        query_key = str(payload.get("queryKey") or "")[:500]
        result = payload.get("result")
        if not provider or not query_key or not isinstance(result, (dict, list)):
            return {"written": False, "reason": "invalid"}
        conn.execute(
            """INSERT INTO metadata_cache(provider,query_key,result_json,saved_at,expires_at)
               VALUES(?,?,?,?,?) ON CONFLICT(provider,query_key) DO UPDATE SET
               result_json=excluded.result_json,saved_at=excluded.saved_at,expires_at=excluded.expires_at""",
            (
                provider,
                query_key,
                json.dumps(result, separators=(",", ":"), ensure_ascii=False),
                now,
                now + metadata_ttl,
            ),
        )
        return {"written": True}
    if operation == "state":
        row = conn.execute(
            "SELECT value_json,updated_at FROM build_state WHERE state_key='catalog'"
        ).fetchone()
        if not row:
            return None
        try:
            value = json.loads(row[0])
        except Exception:
            value = {}
        return {"value": value if isinstance(value, dict) else {}, "updatedAt": int(row[1])}
    if operation == "prune":
        return prune()
    raise ValueError("unknown operation")


for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    request_id = None
    try:
        request = json.loads(raw_line)
        request_id = request.get("id")
        result = handle(request)
        response = {"id": request_id, "ok": True, "result": result}
    except Exception as exc:
        response = {"id": request_id, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    sys.stdout.write(json.dumps(response, separators=(",", ":"), ensure_ascii=False) + "\n")
    sys.stdout.flush()
