'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { titleTokens } = require('./tpb4k/sukebei-hentai-title');

function truthy(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function safeRuntimeRoot(env = process.env) {
  const root = path.resolve(String(env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime'));
  if (root !== '/tmp' && !root.startsWith('/tmp/')) {
    throw new Error('Sukebei Hentai SQLite runtime must remain under /tmp');
  }
  return root;
}

function sukebeiHentaiDbPath(env = process.env) {
  const root = safeRuntimeRoot(env);
  const configured = String(env.ONLYPORN_SUKEBEI_HENTAI_DB || '').trim();
  const target = path.resolve(configured || path.join(root, 'sukebei-hentai', 'sukebei-hentai-v1.sqlite'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Sukebei Hentai DB must remain inside ONLYPORN_RUNTIME_DIR');
  }
  return target;
}

class SukebeiHentaiSqliteStore {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.enabled = String(this.env.ONLYPORN_SUKEBEI_HENTAI_SQLITE_ENABLED || 'true').toLowerCase() !== 'false'
      && !truthy(this.env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
    this.dbPath = sukebeiHentaiDbPath(this.env);
    this.workerPath = path.resolve(__dirname, '../scripts/sukebei-hentai-sqlite-worker.py');
    this.python = String(this.env.ONLYPORN_SUKEBEI_HENTAI_PYTHON || 'python3');
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
  }

  _start() {
    if (!this.enabled || this.child) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    const child = spawn(this.python, [this.workerPath, this.dbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env, PYTHONUNBUFFERED: '1' },
    });
    this.child = child;
    child.unref?.();
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stderr.unref?.();
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      let message;
      try { message = JSON.parse(String(line || '')); } catch { return; }
      const pending = this.pending.get(Number(message?.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error || 'Sukebei Hentai SQLite worker error')));
    });
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk || '')}`.slice(-4_000);
    });
    child.on('error', error => {
      this._rejectAll(error);
      this.child = null;
    });
    child.on('exit', code => {
      this._rejectAll(new Error(`Sukebei Hentai SQLite worker exited ${code}; ${this.stderr}`));
      this.child = null;
    });
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async _request(op, payload = {}, timeoutMs = 10_000) {
    if (!this.enabled) return null;
    this._start();
    if (!this.child?.stdin?.writable) throw new Error('Sukebei Hentai SQLite worker unavailable');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sukebei Hentai SQLite ${op} timed out`));
      }, Math.max(Number(timeoutMs || 0), 500));
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, payload })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async ping() {
    return this._request('ping');
  }

  async replaceIndex(payload) {
    return this._request('replace_index', payload, 30_000);
  }

  async listSeries({ query = '', limit = 100, offset = 0 } = {}) {
    const tokens = query ? titleTokens(query) : [];
    const value = await this._request('list_series', { tokens, limit, offset });
    return Array.isArray(value) ? value : [];
  }

  async getItem(sourceId) {
    return this._request('get_item', { sourceId: String(sourceId || '') });
  }

  async getMetadata(provider, queryKey) {
    return this._request('get_metadata', {
      provider: String(provider || ''),
      queryKey: String(queryKey || ''),
    });
  }

  async putMetadata(provider, queryKey, result) {
    return this._request('put_metadata', {
      provider: String(provider || ''),
      queryKey: String(queryKey || ''),
      result,
    });
  }

  async state() {
    return this._request('state');
  }

  async stats() {
    return this._request('stats');
  }

  async prune() {
    return this._request('prune');
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    this._rejectAll(new Error('Sukebei Hentai SQLite store closed'));
  }
}

function createSukebeiHentaiSqliteStore(options = {}) {
  return new SukebeiHentaiSqliteStore(options);
}

module.exports = {
  SukebeiHentaiSqliteStore,
  createSukebeiHentaiSqliteStore,
  safeRuntimeRoot,
  sukebeiHentaiDbPath,
};
