'use strict';
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {spawn}=require('node:child_process');
const {normalizeForMatch,normalizeSearchQuery,searchItemId,visibleSearchText}=require('./tpb4k/search-engine');
function truthy(v){return /^(?:1|true|yes|on)$/i.test(String(v||'').trim());}
function safeRuntimeRoot(env=process.env){
  const root=path.resolve(String(env.ONLYPORN_RUNTIME_DIR||'/tmp/onlyporn-runtime'));
  if (!root.startsWith('/tmp/')) throw new Error('OnlyPorn search SQLite runtime must remain under /tmp');
  return root;
}
function searchDbPath(env=process.env){
  const root=safeRuntimeRoot(env); const configured=String(env.ONLYPORN_SEARCH_DB||'').trim();
  const target=path.resolve(configured||path.join(root,'search','search-v1.sqlite'));
  if (target!==root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Search DB must remain inside ONLYPORN_RUNTIME_DIR');
  return target;
}
class SearchSqliteStore {
  constructor(options={}){
    this.env=options.env||process.env;
    this.enabled=String(this.env.ONLYPORN_SEARCH_SQLITE_ENABLED||'true').toLowerCase()!=='false' && !truthy(this.env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
    this.dbPath=searchDbPath(this.env); this.workerPath=path.resolve(__dirname,'../scripts/search-sqlite-worker.py');
    this.python=String(this.env.ONLYPORN_SEARCH_PYTHON||'python3'); this.child=null; this.nextId=1; this.pending=new Map(); this.stderr='';
  }
  _start(){
    if (!this.enabled||this.child) return;
    fs.mkdirSync(path.dirname(this.dbPath),{recursive:true,mode:0o700});
    const child=spawn(this.python,[this.workerPath,this.dbPath],{stdio:['pipe','pipe','pipe'],env:{...process.env,...this.env,PYTHONUNBUFFERED:'1'}});
    this.child=child; child.unref?.(); child.stdin.unref?.(); child.stdout.unref?.(); child.stderr.unref?.();
    const reader=readline.createInterface({input:child.stdout});
    reader.on('line',line=>{let m; try{m=JSON.parse(String(line||''));}catch{return;} const p=this.pending.get(Number(m?.id)); if(!p)return;
      this.pending.delete(Number(m.id)); clearTimeout(p.timer); m.ok?p.resolve(m.result):p.reject(new Error(String(m.error||'search SQLite worker error')));});
    child.stderr.on('data',c=>{this.stderr=`${this.stderr}${String(c||'')}`.slice(-4000);});
    child.on('error',e=>{this._rejectAll(e);this.child=null;});
    child.on('exit',code=>{this._rejectAll(new Error(`search SQLite worker exited ${code}; ${this.stderr}`));this.child=null;});
  }
  _rejectAll(error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();}
  async _request(op,payload={},timeoutMs=6000){
    if(!this.enabled)return null; this._start(); if(!this.child?.stdin?.writable)throw new Error('search SQLite worker unavailable'); const id=this.nextId++;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`search SQLite ${op} timed out`));},Math.max(Number(timeoutMs||0),500));
      this.pending.set(id,{resolve,reject,timer}); this.child.stdin.write(`${JSON.stringify({id,op,payload})}\n`,error=>{if(!error)return;const p=this.pending.get(id);if(!p)return;this.pending.delete(id);clearTimeout(timer);reject(error);});});
  }
  async getQuery(catalogId,query){try{return await this._request('get_query',{catalogId:String(catalogId||''),queryKey:normalizeForMatch(normalizeSearchQuery(query))});}catch{return null;}}
  async putQuery(catalogId,query,metas){try{return await this._request('put_query',{catalogId:String(catalogId||''),queryKey:normalizeForMatch(normalizeSearchQuery(query)),metas:Array.isArray(metas)?metas:[]});}catch{return null;}}
  async upsertPool(catalogId,items){
    const rows=(Array.isArray(items)?items:[]).map((item,index)=>({itemId:searchItemId(item,index),searchText:visibleSearchText(item),item})).filter(r=>r.itemId&&r.searchText);
    if(!rows.length)return null; try{return await this._request('upsert_pool',{catalogId:String(catalogId||''),rows},10000);}catch{return null;}
  }
  async countPool(catalogId){
    try{
      const value=await this._request('count_pool',{catalogId:String(catalogId||'')});
      return Math.max(Number(value||0),0);
    }catch{return 0;}
  }
  async listPool(catalogId,limit=300){
    try{
      const value=await this._request('list_pool',{catalogId:String(catalogId||''),limit});
      return Array.isArray(value)?value:[];
    }catch{return[];}
  }
  async searchPool(catalogId,query,limit=160){
    const normalized=normalizeForMatch(normalizeSearchQuery(query));const tokens=normalized.split(' ').filter(Boolean);if(!tokens.length)return[];
    try{const result=await this._request('search_pool',{catalogId:String(catalogId||''),tokens,limit});return Array.isArray(result)?result:[];}catch{return[];}
  }
  async stats(){try{return await this._request('stats',{});}catch{return null;}}
  async close(){const child=this.child;this.child=null;if(!child)return;try{child.stdin.end();}catch{}try{child.kill('SIGTERM');}catch{}this._rejectAll(new Error('search SQLite store closed'));}
}
function createSearchSqliteStore(options={}){return new SearchSqliteStore(options);}
module.exports={SearchSqliteStore,createSearchSqliteStore,safeRuntimeRoot,searchDbPath};
