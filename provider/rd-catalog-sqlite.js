'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

function truthy(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || '').trim());
}

function normalizeJavCode(value) {
  const text = String(value || '').normalize('NFKC').toUpperCase().trim();
  const fc2 = text.match(/\bFC2[\s._-]*(?:PPV[\s._-]*)?(\d{5,9})\b/);
  if (fc2) return `FC2-PPV-${fc2[1]}`;
  const match = text.match(/\b([A-Z]{2,24})[\s._-]+(\d{2,7})\b/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function safeRuntimeRoot(env = process.env) {
  const root = path.resolve(String(env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime'));
  if (!root.startsWith('/tmp/')) throw new Error('OnlyPorn RD catalog runtime must remain under /tmp');
  return root;
}

function rdCatalogDbPath(env = process.env) {
  const root = safeRuntimeRoot(env);
  const configured = String(env.ONLYPORN_RD_CATALOG_DB || '').trim();
  const target = path.resolve(configured || path.join(root, 'rd-catalog', 'rd-catalog-v1.sqlite'));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('RD catalog DB must remain inside ONLYPORN_RUNTIME_DIR');
  }
  return target;
}

class RdCatalogSqliteStore {
  constructor(options = {}) {
    this.env = options.env || process.env;
    this.enabled = truthy(this.env.ONLYPORN_RD_CATALOG_ENABLED) &&
      !truthy(this.env.ONLYPORN_DISABLE_PERSISTENT_CACHE);
    this.dbPath = rdCatalogDbPath(this.env);
    this.workerPath = path.resolve(__dirname, '../scripts/rd-catalog-sqlite-worker.py');
    this.python = String(this.env.ONLYPORN_RD_CATALOG_PYTHON || 'python3');
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.lastError = '';
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
      else {
        const error = new Error(String(message.error || 'RD catalog SQLite worker error'));
        this.lastError = error.message;
        pending.reject(error);
      }
    });
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${String(chunk || '')}`.slice(-4000);
    });
    child.on('error', error => {
      this.lastError = String(error?.message || error);
      this._rejectAll(error);
      this.child = null;
    });
    child.on('exit', code => {
      const error = new Error(`RD catalog SQLite worker exited ${code}; ${this.stderr}`);
      this.lastError = error.message;
      this._rejectAll(error);
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

  async _request(op, payload = {}, timeoutMs = 8_000) {
    if (!this.enabled) return null;
    this._start();
    if (!this.child?.stdin?.writable) throw new Error('RD catalog SQLite worker unavailable');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`RD catalog SQLite ${op} timed out`);
        this.lastError = error.message;
        reject(error);
      }, Math.max(Number(timeoutMs || 0), 500));
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, payload })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.lastError = String(error?.message || error);
        reject(error);
      });
    });
  }

  async importReport(reportPath) {
    return this._request('import_report', { reportPath: path.resolve(String(reportPath || '')) }, 120_000);
  }

  async mappingsForCodes(values) {
    const codes = [...new Set((Array.isArray(values) ? values : [])
      .map(normalizeJavCode).filter(Boolean))].slice(0, 500);
    if (!codes.length) return {};
    try {
      const result = await this._request('get_mappings', { codes });
      return result && typeof result === 'object' ? result : {};
    } catch { return {}; }
  }

  async mappingsForCode(value) {
    const code = normalizeJavCode(value);
    if (!code) return [];
    const result = await this.mappingsForCodes([code]);
    return Array.isArray(result[code]) ? result[code] : [];
  }

  async postersForCodes(values) {
    const codes = [...new Set((Array.isArray(values) ? values : [])
      .map(normalizeJavCode).filter(Boolean))].slice(0, 500);
    if (!codes.length) return {};
    try {
      const result = await this._request('get_posters', { codes });
      return result && typeof result === 'object' ? result : {};
    } catch { return {}; }
  }

  async upsertPoster(code, scene = {}) {
    const normalized = normalizeJavCode(code);
    if (!normalized || !scene?.poster) return null;
    return this._request('upsert_poster', { code: normalized, scene });
  }

  async upsertPosters(rows) {
    const normalized = (Array.isArray(rows) ? rows : []).map(row => ({
      code: normalizeJavCode(row?.code),
      scene: row?.scene,
    })).filter(row => row.code && row.scene?.poster).slice(0, 500);
    if (!normalized.length) return { written: 0 };
    return this._request('upsert_posters', { rows: normalized }, 15_000);
  }

  async recordPosterAttempt(code, status, error = '') {
    const normalized = normalizeJavCode(code);
    if (!normalized) return null;
    return this._request('poster_attempt', {
      code: normalized,
      status: String(status || '').slice(0, 32),
      error: String(error || '').slice(0, 1000),
    });
  }

  async codesNeedingPosters(limit = 250, options = {}) {
    try {
      const result = await this._request('codes_needing_posters', {
        limit: Math.min(Math.max(Number(limit || 250), 1), 5000),
        retryMissing: Boolean(options.retryMissing),
      });
      return Array.isArray(result) ? result : [];
    } catch { return []; }
  }

  async stats() {
    try {
      const result = await this._request('stats', {});
      return { ...(result || {}), enabled: this.enabled, lastError: this.lastError };
    } catch {
      return { enabled: this.enabled, dbPath: this.dbPath, lastError: this.lastError };
    }
  }

  async close() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
    this._rejectAll(new Error('RD catalog SQLite store closed'));
  }
}

function createRdCatalogSqliteStore(options = {}) {
  return new RdCatalogSqliteStore(options);
}

module.exports = {
  RdCatalogSqliteStore,
  createRdCatalogSqliteStore,
  normalizeJavCode,
  rdCatalogDbPath,
  safeRuntimeRoot,
};
