#!/usr/bin/env python3
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('usage: rd-catalog-sqlite-worker.py <db-path>')

db_path = Path(sys.argv[1]).resolve()
db_path.parent.mkdir(parents=True, exist_ok=True)
try:
    os.chmod(db_path.parent, 0o700)
except OSError:
    pass

new_db = not db_path.exists()
conn = sqlite3.connect(str(db_path), timeout=15.0, isolation_level=None)
conn.execute('PRAGMA busy_timeout=15000')
if new_db:
    conn.execute('PRAGMA auto_vacuum=INCREMENTAL')
conn.execute('PRAGMA journal_mode=WAL')
conn.execute('PRAGMA synchronous=FULL')
conn.execute('PRAGMA foreign_keys=ON')
conn.execute('PRAGMA temp_store=FILE')
conn.execute('PRAGMA wal_autocheckpoint=500')
conn.executescript('''
CREATE TABLE IF NOT EXISTS import_runs (
 import_id INTEGER PRIMARY KEY AUTOINCREMENT,
 report_version TEXT NOT NULL,
 source_name TEXT NOT NULL,
 source_generated_at TEXT NOT NULL,
 imported_at INTEGER NOT NULL,
 universe INTEGER NOT NULL,
 complete INTEGER NOT NULL,
 pending INTEGER NOT NULL,
 missing INTEGER NOT NULL,
 report_sha256 TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS rd_codes (
 code TEXT PRIMARY KEY,
 original_hash TEXT NOT NULL,
 current_hash TEXT NOT NULL,
 final_state TEXT NOT NULL,
 hash_relation TEXT NOT NULL,
 batch INTEGER NOT NULL,
 position INTEGER NOT NULL,
 filename TEXT NOT NULL,
 rd_id TEXT NOT NULL,
 status TEXT NOT NULL,
 progress REAL NOT NULL,
 match_source TEXT NOT NULL,
 candidate_count INTEGER NOT NULL,
 source_generated_at TEXT NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rd_codes_state ON rd_codes(final_state, status);
CREATE TABLE IF NOT EXISTS rd_hashes (
 code TEXT NOT NULL REFERENCES rd_codes(code) ON DELETE CASCADE,
 info_hash TEXT NOT NULL,
 rd_id TEXT NOT NULL,
 status TEXT NOT NULL,
 filename TEXT NOT NULL,
 hash_relation TEXT NOT NULL,
 match_source TEXT NOT NULL,
 verified_downloaded INTEGER NOT NULL,
 preferred INTEGER NOT NULL,
 first_seen_at INTEGER NOT NULL,
 last_seen_at INTEGER NOT NULL,
 PRIMARY KEY(code, info_hash)
);
CREATE INDEX IF NOT EXISTS rd_hashes_lookup ON rd_hashes(code, verified_downloaded DESC, preferred DESC, last_seen_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rd_hashes_hash_code ON rd_hashes(info_hash, code);
CREATE TABLE IF NOT EXISTS code_posters (
 code TEXT PRIMARY KEY REFERENCES rd_codes(code) ON DELETE CASCADE,
 provider TEXT NOT NULL,
 provider_id TEXT NOT NULL,
 title TEXT NOT NULL,
 poster TEXT NOT NULL,
 background TEXT NOT NULL,
 studio TEXT NOT NULL,
 performers_json TEXT NOT NULL,
 tags_json TEXT NOT NULL,
 release_date TEXT NOT NULL,
 verified_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS poster_attempts (
 code TEXT PRIMARY KEY REFERENCES rd_codes(code) ON DELETE CASCADE,
 status TEXT NOT NULL,
 error TEXT NOT NULL,
 attempted_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL
);
''')
try:
    os.chmod(db_path, 0o600)
except OSError:
    pass

HASH_RE = re.compile(r'^[a-f0-9]{40}$')
CODE_RE = re.compile(r'^([A-Z]{2,24})-(\d{2,7})$')
FC2_RE = re.compile(r'^FC2-PPV-(\d{5,9})$')

def now_ms():
    return int(time.time() * 1000)

def compact(value, limit=1000):
    return ' '.join(str(value or '').split()).strip()[:limit]

def normalize_hash(value):
    text = compact(value, 80).lower()
    return text if HASH_RE.fullmatch(text) else ''

def normalize_code(value):
    text = compact(value, 80).upper().replace('_', '-').replace(' ', '-')
    text = re.sub(r'-+', '-', text)
    return text if CODE_RE.fullmatch(text) or FC2_RE.fullmatch(text) else ''

def file_sha256(path):
    import hashlib
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def db_bytes():
    total = 0
    for suffix in ('', '-wal', '-shm'):
        try:
            total += Path(str(db_path) + suffix).stat().st_size
        except OSError:
            pass
    return total

def import_report(report_path_value):
    report_path = Path(str(report_path_value or '')).resolve()
    if not report_path.is_file() or report_path.stat().st_size > 64 * 1024 * 1024:
        raise ValueError('RD audit report is missing or exceeds 64 MiB')
    with report_path.open('r', encoding='utf-8') as handle:
        report = json.load(handle)
    records = report.get('records')
    if not isinstance(records, list) or not records:
        raise ValueError('RD audit report has no records')
    universe = int(report.get('universe') or len(records))
    if universe != len(records):
        raise ValueError('RD audit universe does not match record count')
    digest = file_sha256(report_path)
    existing = conn.execute('SELECT import_id FROM import_runs WHERE report_sha256=?', (digest,)).fetchone()
    if existing:
        result = stats()
        result.update({'importId': existing[0], 'alreadyImported': True})
        return result

    stamp = now_ms()
    generated_at = compact(report.get('generated_at'), 100)
    summary = report.get('summary') if isinstance(report.get('summary'), dict) else {}
    normalized = []
    seen = set()
    for row in records:
        if not isinstance(row, dict):
            raise ValueError('RD audit record must be an object')
        code = normalize_code(row.get('code'))
        original_hash = normalize_hash(row.get('original_hash'))
        current_hash = normalize_hash(row.get('current_hash'))
        state = compact(row.get('final_state'), 32).upper()
        if not code or not original_hash or code in seen:
            raise ValueError(f'invalid or duplicate RD audit code: {code or row.get("code")}')
        if state not in {'COMPLETE', 'PENDING', 'MISSING', 'TERMINAL'}:
            raise ValueError(f'invalid RD audit state for {code}: {state}')
        if state == 'COMPLETE' and (not current_hash or compact(row.get('status'), 32).lower() != 'downloaded'):
            raise ValueError(f'complete RD audit row lacks downloaded hash: {code}')
        seen.add(code)
        normalized.append({
            'code': code,
            'original_hash': original_hash,
            'current_hash': current_hash,
            'state': state,
            'hash_relation': compact(row.get('hash_relation'), 64).upper(),
            'batch': max(int(row.get('batch') or 0), 0),
            'position': max(int(row.get('position') or 0), 0),
            'filename': compact(row.get('filename'), 1000),
            'rd_id': compact(row.get('current_rd_id'), 100),
            'status': compact(row.get('status'), 32).lower(),
            'progress': float(row.get('progress') or 0),
            'match_source': compact(row.get('match_source'), 64).upper(),
            'candidate_count': max(int(row.get('candidate_count') or 0), 0),
        })

    conn.execute('BEGIN IMMEDIATE')
    try:
        cursor = conn.execute('''INSERT INTO import_runs(
          report_version,source_name,source_generated_at,imported_at,universe,complete,pending,missing,report_sha256
        ) VALUES(?,?,?,?,?,?,?,?,?)''', (
            compact(report.get('version'), 40), report_path.name, generated_at, stamp, universe,
            int(summary.get('complete') or 0), int(summary.get('pending') or 0), int(summary.get('missing') or 0), digest,
        ))
        import_id = cursor.lastrowid
        for row in normalized:
            conn.execute('''INSERT INTO rd_codes(
              code,original_hash,current_hash,final_state,hash_relation,batch,position,filename,rd_id,status,
              progress,match_source,candidate_count,source_generated_at,updated_at
            ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
              original_hash=excluded.original_hash,current_hash=excluded.current_hash,final_state=excluded.final_state,
              hash_relation=excluded.hash_relation,batch=excluded.batch,position=excluded.position,
              filename=excluded.filename,rd_id=excluded.rd_id,status=excluded.status,progress=excluded.progress,
              match_source=excluded.match_source,candidate_count=excluded.candidate_count,
              source_generated_at=excluded.source_generated_at,updated_at=excluded.updated_at''', (
                row['code'], row['original_hash'], row['current_hash'], row['state'], row['hash_relation'],
                row['batch'], row['position'], row['filename'], row['rd_id'], row['status'], row['progress'],
                row['match_source'], row['candidate_count'], generated_at, stamp,
            ))
            conn.execute('UPDATE rd_hashes SET preferred=0 WHERE code=?', (row['code'],))
            if row['current_hash']:
                downloaded = 1 if row['state'] == 'COMPLETE' and row['status'] == 'downloaded' else 0
                conn.execute('''INSERT INTO rd_hashes(
                  code,info_hash,rd_id,status,filename,hash_relation,match_source,verified_downloaded,
                  preferred,first_seen_at,last_seen_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code,info_hash) DO UPDATE SET
                  rd_id=excluded.rd_id,status=excluded.status,filename=excluded.filename,
                  hash_relation=excluded.hash_relation,match_source=excluded.match_source,
                  verified_downloaded=MAX(rd_hashes.verified_downloaded,excluded.verified_downloaded),
                  preferred=excluded.preferred,last_seen_at=excluded.last_seen_at''', (
                    row['code'], row['current_hash'], row['rd_id'], row['status'], row['filename'],
                    row['hash_relation'], row['match_source'], downloaded, downloaded, stamp, stamp,
                ))
        conn.execute('COMMIT')
    except Exception:
        conn.execute('ROLLBACK')
        raise
    result = stats()
    result.update({'importId': import_id, 'alreadyImported': False, 'importedRecords': len(normalized)})
    return result

def stats():
    code_rows = conn.execute('''SELECT COUNT(*),
      SUM(final_state='COMPLETE'),SUM(final_state='PENDING'),SUM(final_state='MISSING'),
      SUM(hash_relation='MODIFIED_NEW_HASH') FROM rd_codes''').fetchone()
    hash_rows = conn.execute('SELECT COUNT(*),SUM(verified_downloaded=1),SUM(preferred=1) FROM rd_hashes').fetchone()
    poster_rows = conn.execute('SELECT COUNT(*) FROM code_posters').fetchone()[0]
    attempts = dict(conn.execute('SELECT status,COUNT(*) FROM poster_attempts GROUP BY status').fetchall())
    last_import = conn.execute('''SELECT import_id,source_name,source_generated_at,imported_at,universe,complete,pending,missing
      FROM import_runs ORDER BY import_id DESC LIMIT 1''').fetchone()
    return {
        'dbPath': str(db_path), 'dbBytes': db_bytes(), 'codes': int(code_rows[0] or 0),
        'complete': int(code_rows[1] or 0), 'pending': int(code_rows[2] or 0),
        'missing': int(code_rows[3] or 0), 'modifiedHashes': int(code_rows[4] or 0),
        'hashes': int(hash_rows[0] or 0), 'verifiedDownloadedHashes': int(hash_rows[1] or 0),
        'preferredHashes': int(hash_rows[2] or 0), 'posters': int(poster_rows or 0),
        'posterAttempts': attempts,
        'lastImport': ({'importId': last_import[0], 'sourceName': last_import[1],
                        'sourceGeneratedAt': last_import[2], 'importedAt': last_import[3],
                        'universe': last_import[4], 'complete': last_import[5],
                        'pending': last_import[6], 'missing': last_import[7]} if last_import else None),
    }

def get_mappings(codes):
    output = {code: [] for code in codes}
    if not codes:
        return output
    placeholders = ','.join('?' for _ in codes)
    rows = conn.execute(f'''SELECT code,info_hash,rd_id,status,filename,hash_relation,match_source,
      verified_downloaded,preferred,last_seen_at FROM rd_hashes
      WHERE code IN ({placeholders}) AND verified_downloaded=1
      ORDER BY code,preferred DESC,last_seen_at DESC,info_hash''', codes).fetchall()
    for row in rows:
        output.setdefault(row[0], []).append({
            'code': row[0], 'infoHash': row[1], 'rdId': row[2], 'status': row[3],
            'filename': row[4], 'hashRelation': row[5], 'matchSource': row[6],
            'verifiedDownloaded': bool(row[7]), 'preferred': bool(row[8]), 'lastSeenAt': row[9],
        })
    return output

def get_posters(codes):
    output = {}
    if not codes:
        return output
    placeholders = ','.join('?' for _ in codes)
    rows = conn.execute(f'''SELECT code,provider,provider_id,title,poster,background,studio,
      performers_json,tags_json,release_date,verified_at,updated_at FROM code_posters
      WHERE code IN ({placeholders})''', codes).fetchall()
    for row in rows:
        try:
            performers = json.loads(row[7])
            tags = json.loads(row[8])
        except Exception:
            performers, tags = [], []
        output[row[0]] = {
            'code': row[0], 'provider': row[1], 'providerId': row[2], 'title': row[3],
            'poster': row[4], 'background': row[5], 'studio': row[6],
            'performers': performers, 'tags': tags, 'releaseDate': row[9],
            'verifiedAt': row[10], 'updatedAt': row[11],
        }
    return output

def upsert_poster(code, scene):
    poster = compact(scene.get('poster'), 2000)
    if not poster.startswith('https://'):
        raise ValueError('poster must use HTTPS')
    provider = compact(scene.get('provider'), 100)
    provider_id = compact(scene.get('providerId'), 300)
    scene_id = compact(scene.get('id'), 500)
    if (not provider or not provider_id) and ':' in scene_id:
        provider, provider_id = scene_id.split(':', 1)
    studio = scene.get('studio')
    if isinstance(studio, dict):
        studio = studio.get('name')
    stamp = now_ms()
    conn.execute('''INSERT INTO code_posters(
      code,provider,provider_id,title,poster,background,studio,performers_json,tags_json,
      release_date,verified_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
      provider=excluded.provider,provider_id=excluded.provider_id,title=excluded.title,
      poster=excluded.poster,background=excluded.background,studio=excluded.studio,
      performers_json=excluded.performers_json,tags_json=excluded.tags_json,
      release_date=excluded.release_date,verified_at=excluded.verified_at,updated_at=excluded.updated_at''', (
        code, compact(provider, 100), compact(provider_id, 300), compact(scene.get('title'), 1000),
        poster, compact(scene.get('background') or poster, 2000), compact(studio, 300),
        json.dumps(scene.get('performers') if isinstance(scene.get('performers'), list) else [], ensure_ascii=False, separators=(',', ':')),
        json.dumps(scene.get('tags') if isinstance(scene.get('tags'), list) else [], ensure_ascii=False, separators=(',', ':')),
        compact(scene.get('release_date') or scene.get('releaseDate'), 100), stamp, stamp,
    ))
    conn.execute('''INSERT INTO poster_attempts(code,status,error,attempted_at,attempts) VALUES(?,?,?,?,1)
      ON CONFLICT(code) DO UPDATE SET status=excluded.status,error='',attempted_at=excluded.attempted_at,
      attempts=poster_attempts.attempts+1''', (code, 'found', '', stamp))
    return {'written': True, 'code': code}

def poster_attempt(code, status, error):
    stamp = now_ms()
    conn.execute('''INSERT INTO poster_attempts(code,status,error,attempted_at,attempts) VALUES(?,?,?,?,1)
      ON CONFLICT(code) DO UPDATE SET status=excluded.status,error=excluded.error,
      attempted_at=excluded.attempted_at,attempts=poster_attempts.attempts+1''',
      (code, compact(status, 32), compact(error, 1000), stamp))
    return {'written': True, 'code': code, 'status': status}

def codes_needing_posters(limit, retry_missing):
    where = "p.code IS NULL AND c.final_state='COMPLETE'"
    params = []
    if not retry_missing:
        where += " AND (a.code IS NULL OR a.status NOT IN ('missing'))"
    params.append(limit)
    rows = conn.execute(f'''SELECT c.code,c.filename,c.current_hash,c.original_hash,a.status,a.attempts
      FROM rd_codes c LEFT JOIN code_posters p ON p.code=c.code
      LEFT JOIN poster_attempts a ON a.code=c.code WHERE {where}
      ORDER BY c.batch,c.position LIMIT ?''', params).fetchall()
    return [{'code': row[0], 'filename': row[1], 'currentHash': row[2], 'originalHash': row[3],
             'lastStatus': row[4] or '', 'attempts': int(row[5] or 0)} for row in rows]

def handle(message):
    op = str(message.get('op') or '')
    payload = message.get('payload') or {}
    if op == 'ping':
        return {'dbPath': str(db_path)}
    if op == 'stats':
        return stats()
    if op == 'import_report':
        return import_report(payload.get('reportPath'))
    if op == 'get_mappings':
        codes = [normalize_code(value) for value in (payload.get('codes') or [])]
        codes = [value for value in codes if value][:500]
        return get_mappings(codes)
    if op == 'get_posters':
        codes = [normalize_code(value) for value in (payload.get('codes') or [])]
        codes = [value for value in codes if value][:500]
        return get_posters(codes)
    if op == 'upsert_poster':
        code = normalize_code(payload.get('code'))
        if not code or not isinstance(payload.get('scene'), dict):
            raise ValueError('invalid poster payload')
        return upsert_poster(code, payload['scene'])
    if op == 'upsert_posters':
        rows = payload.get('rows')
        if not isinstance(rows, list):
            raise ValueError('invalid posters payload')
        written = 0
        conn.execute('BEGIN IMMEDIATE')
        try:
            for row in rows[:500]:
                code = normalize_code(row.get('code')) if isinstance(row, dict) else ''
                scene = row.get('scene') if isinstance(row, dict) else None
                if not code or not isinstance(scene, dict):
                    continue
                upsert_poster(code, scene)
                written += 1
            conn.execute('COMMIT')
        except Exception:
            conn.execute('ROLLBACK')
            raise
        return {'written': written}
    if op == 'poster_attempt':
        code = normalize_code(payload.get('code'))
        if not code:
            raise ValueError('invalid poster-attempt code')
        return poster_attempt(code, payload.get('status'), payload.get('error'))
    if op == 'codes_needing_posters':
        limit = min(max(int(payload.get('limit') or 250), 1), 5000)
        return codes_needing_posters(limit, bool(payload.get('retryMissing')))
    raise ValueError('unknown operation')

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    request_id = None
    try:
        message = json.loads(raw)
        request_id = message.get('id')
        response = {'id': request_id, 'ok': True, 'result': handle(message)}
    except Exception as exc:
        response = {'id': request_id, 'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(',', ':')) + '\n')
    sys.stdout.flush()
