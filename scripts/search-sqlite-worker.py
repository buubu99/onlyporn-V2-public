#!/usr/bin/env python3
import json, os, re, shutil, sqlite3, sys, time
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: search-sqlite-worker.py <db-path>")
db_path = Path(sys.argv[1]).resolve()
db_path.parent.mkdir(parents=True, exist_ok=True)
try: os.chmod(db_path.parent, 0o700)
except OSError: pass
# Search pools and exact-query results belong on Render's ephemeral filesystem,
# not in the Node heap. Keep a generous but finite default while preserving a
# 4 GiB free-space floor for MetaTube, logs, posters, and OS headroom.
hard_max = max(int(os.environ.get("ONLYPORN_SEARCH_DB_MAX_BYTES", str(2*1024*1024*1024))), 4*1024*1024)
min_free = max(int(os.environ.get("ONLYPORN_SEARCH_MIN_FREE_BYTES", str(4*1024*1024*1024))), 64*1024*1024)
query_ttl = max(int(os.environ.get("ONLYPORN_SEARCH_QUERY_TTL_MS", str(30*60*1000))), 60000)
negative_ttl = max(int(os.environ.get("ONLYPORN_SEARCH_NEGATIVE_TTL_MS", str(5*60*1000))), 30000)
stale_ttl = max(int(os.environ.get("ONLYPORN_SEARCH_STALE_TTL_MS", str(24*60*60*1000))), query_ttl)
pool_ttl = max(int(os.environ.get("ONLYPORN_SEARCH_POOL_TTL_MS", str(7*24*60*60*1000))), 3600000)
new_db = not db_path.exists()
conn = sqlite3.connect(str(db_path), timeout=5.0, isolation_level=None)
conn.execute("PRAGMA busy_timeout=5000")
if new_db: conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA synchronous=NORMAL")
conn.execute("PRAGMA temp_store=FILE")
conn.execute("PRAGMA mmap_size=0")
conn.execute("PRAGMA cache_size=-2048")
conn.execute("PRAGMA wal_autocheckpoint=1000")
conn.executescript('''
CREATE TABLE IF NOT EXISTS query_cache (
 catalog_id TEXT NOT NULL, query_key TEXT NOT NULL, saved_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, stale_until INTEGER NOT NULL, result_count INTEGER NOT NULL,
 metas_json TEXT NOT NULL, PRIMARY KEY(catalog_id, query_key));
CREATE INDEX IF NOT EXISTS query_cache_expiry ON query_cache(stale_until);
CREATE TABLE IF NOT EXISTS pool_items (
 catalog_id TEXT NOT NULL, item_id TEXT NOT NULL, search_text TEXT NOT NULL,
 item_json TEXT NOT NULL, seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 PRIMARY KEY(catalog_id, item_id));
CREATE INDEX IF NOT EXISTS pool_catalog_expiry ON pool_items(catalog_id, expires_at);
CREATE INDEX IF NOT EXISTS pool_seen ON pool_items(catalog_id, seen_at DESC);
CREATE TABLE IF NOT EXISTS catalog_facets (
 catalog_id TEXT NOT NULL, facet TEXT NOT NULL, value TEXT NOT NULL,
 item_count INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(catalog_id, facet, value));
CREATE INDEX IF NOT EXISTS catalog_facets_rank ON catalog_facets(catalog_id, facet, item_count DESC);
''')
try: os.chmod(db_path, 0o600)
except OSError: pass

def now_ms(): return int(time.time()*1000)
def db_bytes():
    total=0
    for suffix in ('','-wal','-shm'):
        try: total += Path(str(db_path)+suffix).stat().st_size
        except OSError: pass
    return total
def can_write():
    try: return shutil.disk_usage(str(db_path.parent)).free >= min_free
    except OSError: return True
def prune():
    now=now_ms()
    conn.execute("DELETE FROM query_cache WHERE stale_until < ?", (now,))
    conn.execute("DELETE FROM pool_items WHERE expires_at < ?", (now,))
    conn.execute("DELETE FROM catalog_facets WHERE updated_at < ?", (now-pool_ttl,))
    # Enforce a real upper bound. Prefer discarding old broad-pool rows first;
    # if necessary, discard the oldest exact-query rows next. All data here is
    # a regenerable cache, never authoritative application data.
    for _ in range(24):
        if db_bytes() <= hard_max:
            break
        before = conn.total_changes
        conn.execute("DELETE FROM pool_items WHERE rowid IN (SELECT rowid FROM pool_items ORDER BY seen_at ASC LIMIT 1000)")
        if conn.total_changes == before:
            conn.execute("DELETE FROM query_cache WHERE rowid IN (SELECT rowid FROM query_cache ORDER BY saved_at ASC LIMIT 100)")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("PRAGMA incremental_vacuum(512)")
    return {'dbBytes':db_bytes(),'queryRows':conn.execute('SELECT COUNT(*) FROM query_cache').fetchone()[0],
            'poolRows':conn.execute('SELECT COUNT(*) FROM pool_items').fetchone()[0]}
def like_escape(v): return v.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')

def facet_strings(value):
    if not isinstance(value,list): return []
    output=[]
    for item in value[:80]:
        if isinstance(item,dict): item=item.get('name') or item.get('title') or item.get('value') or ''
        text=' '.join(str(item or '').split()).strip()
        if 2 <= len(text) <= 80 and '[object object]' not in text.lower(): output.append(text)
    return output

def item_facets(item):
    found=set()
    for value in facet_strings(item.get('tags')): found.add(('tag',value))
    for value in facet_strings(item.get('genres')):
        found.add(('quality' if value.lower() in {'4k','2160p','1080p','720p'} else 'genre',value))
    for value in facet_strings(item.get('performers')): found.add(('performer',value))
    for link in item.get('links') or []:
        if isinstance(link,dict) and str(link.get('category') or '').lower()=='cast':
            value=' '.join(str(link.get('name') or '').split()).strip()
            if 2 <= len(value) <= 80: found.add(('performer',value))
    for key in ('studio','quality','resolution','series'):
        value=' '.join(str(item.get(key) or '').split()).strip()
        if 2 <= len(value) <= 80: found.add((key,value))
    date=str(item.get('releaseDate') or item.get('released') or item.get('date') or item.get('publishedAt') or '')
    year=re.search(r'\b((?:19|20)\d{2})\b',date)
    if year: found.add(('year',year.group(1)))
    return found

def rebuild_catalog_facets(catalog_id):
    from collections import Counter
    counts=Counter()
    rows=conn.execute('SELECT item_json FROM pool_items WHERE catalog_id=? AND expires_at>=?',(catalog_id,now_ms())).fetchall()
    for (body,) in rows:
        try: item=json.loads(body)
        except Exception: continue
        if not isinstance(item,dict): continue
        for facet in item_facets(item): counts[facet]+=1
    stamp=now_ms()
    conn.execute('BEGIN IMMEDIATE')
    try:
        conn.execute('DELETE FROM catalog_facets WHERE catalog_id=?',(catalog_id,))
        conn.executemany(
            'INSERT INTO catalog_facets(catalog_id,facet,value,item_count,updated_at) VALUES(?,?,?,?,?)',
            [(catalog_id,facet,value,int(amount),stamp) for (facet,value),amount in counts.items()]
        )
        conn.execute('COMMIT')
    except Exception:
        conn.execute('ROLLBACK'); raise
    return len(counts)

def handle(msg):
    op=str(msg.get('op') or ''); p=msg.get('payload') or {}; now=now_ms()
    if op=='ping': return {'dbPath':str(db_path)}
    if op=='stats':
        s=prune(); s.update({'dbPath':str(db_path),'hardMaxBytes':hard_max,'minFreeBytes':min_free}); return s
    if op=='get_query':
        cid=str(p.get('catalogId') or ''); q=str(p.get('queryKey') or '')
        row=conn.execute('SELECT saved_at,expires_at,stale_until,result_count,metas_json FROM query_cache WHERE catalog_id=? AND query_key=?',(cid,q)).fetchone()
        if not row: return None
        saved,exp,stale,count,body=row
        if now>stale:
            conn.execute('DELETE FROM query_cache WHERE catalog_id=? AND query_key=?',(cid,q)); return None
        try: metas=json.loads(body)
        except Exception:
            conn.execute('DELETE FROM query_cache WHERE catalog_id=? AND query_key=?',(cid,q)); return None
        return {'savedAt':saved,'expiresAt':exp,'staleUntil':stale,'fresh':now<=exp,'resultCount':count,'metas':metas if isinstance(metas,list) else []}
    if op=='put_query':
        if not can_write(): return {'written':False,'reason':'low-free-space'}
        cid=str(p.get('catalogId') or ''); q=str(p.get('queryKey') or ''); metas=p.get('metas')
        if not cid or not q or not isinstance(metas,list): return {'written':False,'reason':'invalid'}
        ttl=negative_ttl if not metas else query_ttl; body=json.dumps(metas,separators=(',',':'),ensure_ascii=False)
        conn.execute('''INSERT INTO query_cache(catalog_id,query_key,saved_at,expires_at,stale_until,result_count,metas_json)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(catalog_id,query_key) DO UPDATE SET saved_at=excluded.saved_at,
          expires_at=excluded.expires_at,stale_until=excluded.stale_until,result_count=excluded.result_count,metas_json=excluded.metas_json''',
          (cid,q,now,now+ttl,now+stale_ttl,len(metas),body)); prune(); return {'written':True,'count':len(metas)}
    if op=='upsert_pool':
        if not can_write(): return {'written':False,'reason':'low-free-space','count':0}
        cid=str(p.get('catalogId') or ''); rows=p.get('rows')
        if not cid or not isinstance(rows,list): return {'written':False,'reason':'invalid','count':0}
        if db_bytes()>hard_max: prune()
        if db_bytes()>hard_max: return {'written':False,'reason':'hard-max','count':0}
        count=0; conn.execute('BEGIN IMMEDIATE')
        try:
            for row in rows[:1000]:
                iid=str(row.get('itemId') or ''); search=str(row.get('searchText') or '')[:12000]; item=row.get('item')
                if not iid or not search or not isinstance(item,dict): continue
                body=json.dumps(item,separators=(',',':'),ensure_ascii=False)
                conn.execute('''INSERT INTO pool_items(catalog_id,item_id,search_text,item_json,seen_at,expires_at)
                  VALUES(?,?,?,?,?,?) ON CONFLICT(catalog_id,item_id) DO UPDATE SET search_text=excluded.search_text,
                  item_json=excluded.item_json,seen_at=excluded.seen_at,expires_at=excluded.expires_at''',
                  (cid,iid,search,body,now,now+pool_ttl)); count+=1
            conn.execute('COMMIT')
        except Exception:
            conn.execute('ROLLBACK'); raise
        prune(); return {'written':True,'count':count}
    if op=='count_pool':
        cid=str(p.get('catalogId') or '')
        if not cid: return 0
        return int(conn.execute(
            'SELECT COUNT(*) FROM pool_items WHERE catalog_id=? AND expires_at>=?',
            (cid,now)
        ).fetchone()[0])
    if op=='rebuild_facets':
        cid=str(p.get('catalogId') or '')
        return {'catalogId':cid,'facets':rebuild_catalog_facets(cid) if cid else 0}
    if op=='get_facets':
        cid=str(p.get('catalogId') or ''); limit=min(max(int(p.get('limit') or 20),1),100)
        if not cid: return []
        rows=conn.execute(
            'SELECT facet,value,item_count,updated_at FROM catalog_facets WHERE catalog_id=? ORDER BY item_count DESC,value ASC LIMIT ?',
            (cid,limit)
        ).fetchall()
        return [{'facet':row[0],'value':row[1],'itemCount':row[2],'updatedAt':row[3]} for row in rows]
    if op=='list_pool':
        cid=str(p.get('catalogId') or '')
        limit=min(max(int(p.get('limit') or 300),1),500)
        if not cid: return []
        rows=conn.execute(
            'SELECT item_json FROM pool_items WHERE catalog_id=? AND expires_at>=? ORDER BY seen_at DESC LIMIT ?',
            (cid,now,limit)
        ).fetchall()
        out=[]
        for (body,) in rows:
            try:
                item=json.loads(body)
                if isinstance(item,dict): out.append(item)
            except Exception: pass
        return out
    if op=='search_pool':
        cid=str(p.get('catalogId') or ''); tokens=[str(x or '').strip() for x in (p.get('tokens') or []) if str(x or '').strip()][:12]
        limit=min(max(int(p.get('limit') or 160),1),500)
        if not cid or not tokens: return []
        where=['catalog_id=?','expires_at>=?']; params=[cid,now]
        for token in tokens:
            where.append("search_text LIKE ? ESCAPE '\\'"); params.append('%'+like_escape(token)+'%')
        params.append(limit)
        rows=conn.execute('SELECT item_json FROM pool_items WHERE '+' AND '.join(where)+' ORDER BY seen_at DESC LIMIT ?',params).fetchall()
        out=[]
        for (body,) in rows:
            try:
                item=json.loads(body)
                if isinstance(item,dict): out.append(item)
            except Exception: pass
        return out
    if op=='prune': return prune()
    raise ValueError('unknown operation')

for raw in sys.stdin:
    raw=raw.strip()
    if not raw: continue
    rid=None
    try:
        msg=json.loads(raw); rid=msg.get('id'); result=handle(msg); response={'id':rid,'ok':True,'result':result}
    except Exception as exc:
        response={'id':rid,'ok':False,'error':f'{type(exc).__name__}: {exc}'}
    sys.stdout.write(json.dumps(response,separators=(',',':'),ensure_ascii=False)+'\n'); sys.stdout.flush()
