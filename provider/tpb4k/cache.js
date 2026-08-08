'use strict';

class BoundedTtlCache {
  constructor(options = {}) {
    this.maxEntries = Math.max(Number.parseInt(String(options.maxEntries || 500), 10) || 500, 1);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.entries = new Map();
    this.pruneTimer = setInterval(() => this.pruneExpired(), 60_000);
    this.pruneTimer.unref?.();
  }

  _deleteExpired(key, entry) {
    if (!entry || entry.expiresAt > this.now()) return false;
    this.entries.delete(key);
    return true;
  }

  getEntry(key) {
    const normalizedKey = String(key || '');
    const entry = this.entries.get(normalizedKey);
    if (!entry || this._deleteExpired(normalizedKey, entry)) return null;
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, entry);
    return Object.freeze({ value: entry.value, negative: entry.negative });
  }

  get(key) {
    const entry = this.getEntry(key);
    return entry && !entry.negative ? entry.value : undefined;
  }

  hasNegative(key) {
    return Boolean(this.getEntry(key)?.negative);
  }

  set(key, value, ttlMs) {
    return this._set(key, value, ttlMs, false);
  }

  setNegative(key, ttlMs) {
    return this._set(key, null, ttlMs, true);
  }

  _set(key, value, ttlMs, negative) {
    const normalizedKey = String(key || '');
    const ttl = Math.max(Number.parseInt(String(ttlMs || 0), 10) || 0, 1);
    if (!normalizedKey) return value;
    this.entries.delete(normalizedKey);
    this.entries.set(normalizedKey, {
      value,
      negative: Boolean(negative),
      expiresAt: this.now() + ttl,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear() {
    this.entries.clear();
  }

  pruneExpired() {
    for (const [key, entry] of this.entries) this._deleteExpired(key, entry);
  }

  close() {
    clearInterval(this.pruneTimer);
    this.clear();
  }

  get size() {
    this.pruneExpired();
    return this.entries.size;
  }
}

module.exports = {
  BoundedTtlCache,
};
