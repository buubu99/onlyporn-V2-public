const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const logger = require('../logger');

const ROOT = path.resolve(__dirname, '..');
const HELPER = path.join(ROOT, 'scripts', 'safari_fetch_helper.py');
const VENV_PYTHON = process.platform === 'win32'
  ? path.join(ROOT, '.python-venv', 'Scripts', 'python.exe')
  : path.join(ROOT, '.python-venv', 'bin', 'python');
const MAX_STDERR_CHARS = 500;

class SafariImpersonationClient {
  constructor() {
    this.child = null;
    this.sequence = 0;
    this.pending = new Map();
    this.cookieHeaders = new Map();
  }

  start() {
    if (this.child && !this.child.killed) return;

    const python = process.env.PYTHON_BIN || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');

    const child = spawn(python, ['-u', HELPER], {
      cwd: ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    const output = readline.createInterface({ input: child.stdout });
    output.on('line', line => this.onLine(line));

    child.stderr.on('data', chunk => {
      const message = String(chunk || '').trim().slice(0, MAX_STDERR_CHARS);
      if (message) logger.warn({ helper: 'safari', error: message }, 'Safari helper stderr');
    });

    child.on('error', error => this.onExit(child, error));
    child.on('exit', (code, signal) => {
      this.onExit(
        child,
        new Error(`Safari helper exited (${code ?? 'null'}/${signal ?? 'none'})`)
      );
    });
  }

  onExit(child, error) {
    if (this.child !== child) return;
    this.child = null;
    if (child?.stdout) child.stdout.removeAllListeners();

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      logger.warn({ helper: 'safari' }, 'Safari helper returned invalid JSON');
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (!message.ok) {
      const error = new Error(message.error || `HTTP ${message.status || 'unknown'}`);
      if (message.status) error.status = message.status;
      error.headers = message.headers || {};
      pending.reject(error);
      return;
    }

    if (message.cookieHeader) {
      this.cookieHeaders.set(pending.profile, message.cookieHeader);
    }

    pending.resolve({
      data: Buffer.from(message.bodyBase64 || '', 'base64').toString('utf8'),
      status: message.status,
      headers: message.headers || {},
      finalUrl: message.finalUrl,
      cookieHeader: message.cookieHeader || '',
    });
  }

  getCookieHeader(profile = 'spankbang') {
    return this.cookieHeaders.get(String(profile || 'spankbang').toLowerCase()) || '';
  }

  async fetchText(url, options = {}) {
    this.start();
    if (!this.child?.stdin?.writable) throw new Error('Safari helper is unavailable');

    const id = ++this.sequence;
    const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || 30000), 45000));
    const profile = String(options.profile || 'spankbang').toLowerCase();
    const payload = {
      id,
      url,
      profile,
      method: String(options.method || 'GET').toUpperCase(),
      data: options.data,
      timeoutMs,
      maxBytes: options.maxBytes || 5 * 1024 * 1024,
      headers: options.headers || {},
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Safari helper timed out after ${timeoutMs}ms`));
        if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      }, timeoutMs + 2000);

      this.pending.set(id, { resolve, reject, timer, profile });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetchText(url, options);
    try {
      return {
        ...response,
        data: JSON.parse(response.data || 'null'),
      };
    } catch (error) {
      const invalid = new Error(`Safari helper returned invalid JSON: ${error.message}`);
      invalid.status = response.status;
      invalid.headers = response.headers;
      throw invalid;
    }
  }
}

module.exports = new SafariImpersonationClient();
