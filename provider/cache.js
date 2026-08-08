class BoundedTtlCache {
  constructor({ maxEntries = 200, ttlMs = 5_000 } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new TypeError('maxEntries must be a positive integer');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive number');
    }

    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.store = new Map();
    const pruneIntervalMs = Math.min(Math.max(Math.floor(ttlMs), 1_000), 60_000);
    this.pruneTimer = setInterval(() => this.pruneExpired(), pruneIntervalMs);
    this.pruneTimer.unref?.();
  }

  get size() {
    this.pruneExpired();
    return this.store.size;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }

    // Refresh insertion order so eviction behaves like a small LRU cache.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (!this.isCacheable(value)) return false;

    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });

    this.pruneExpired();
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }

    return true;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  close() {
    clearInterval(this.pruneTimer);
    this.clear();
  }

  pruneExpired(now = Date.now()) {
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
  }

  isCacheable(value) {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Buffer.isBuffer(value)) return value.length > 0;
    return true;
  }
}

module.exports = BoundedTtlCache;
