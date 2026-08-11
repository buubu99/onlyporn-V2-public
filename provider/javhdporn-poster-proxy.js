'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PUBLIC_BASE = 'https://onlyv2.51-79-157-182.sslip.io';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_ROOTS = Object.freeze(['javhdporn.net', 'pornfhd.com']);
const ALLOWED_HOSTS = Object.freeze(['i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'www9.javfun.me']);
const FC2_STORAGE_HOST = /^storage\d+\.contents\.fc2\.com$/i;
const inFlight = new Map();

function allowedHost(hostname) {
  const host = String(hostname || '').toLocaleLowerCase('en-US');
  return ALLOWED_HOSTS.includes(host) || FC2_STORAGE_HOST.test(host) ||
    ALLOWED_ROOTS.some(root => host === root || host.endsWith(`.${root}`));
}

function publicBase(env = process.env) {
  try {
    const parsed = new URL(String(
      env.ONLYPORN_PUBLIC_BASE_URL ||
      env.ADDON_BASE_URL ||
      env.PUBLIC_URL ||
      DEFAULT_PUBLIC_BASE
    ));
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
      ? parsed.origin
      : DEFAULT_PUBLIC_BASE;
  } catch {
    return DEFAULT_PUBLIC_BASE;
  }
}

function normalizeSourceUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return '';
    if (ALLOWED_HOSTS.includes(parsed.hostname.toLocaleLowerCase('en-US'))) {
      const embedded = parsed.pathname.match(/^\/(storage\d+\.contents\.fc2\.com)(\/.*)$/i);
      if (!embedded) return '';
      return new URL(`https://${embedded[1].toLocaleLowerCase('en-US')}${embedded[2]}`).toString();
    }
    if (!allowedHost(parsed.hostname)) return '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function encodeSource(value) {
  const normalized = normalizeSourceUrl(value);
  return normalized ? Buffer.from(normalized).toString('base64url') : '';
}

function decodeSource(value) {
  try { return normalizeSourceUrl(Buffer.from(String(value || ''), 'base64url').toString()); }
  catch { return ''; }
}

function canonicalJavPosterSource(value) {
  const input = String(value || '').trim();
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  // Live JAVHDPorn search cards currently expose Jetpack/WordPress image
  // wrappers such as:
  //   https://i1.wp.com/www9.javfun.me/Cms_Data/Contents/admin/...jpg?...
  // Those wrapper URLs return 404, while the embedded JAVFun origin is the
  // actual image source. Keep this rewrite deliberately narrow.
  if (!/^i[0-3]\.wp\.com$/i.test(parsed.hostname)) return input;

  const firstSlash = parsed.pathname.indexOf('/', 1);
  if (firstSlash <= 1) return input;

  const embeddedHost = parsed.pathname.slice(1, firstSlash).toLowerCase();
  if (embeddedHost !== 'www9.javfun.me') return input;

  const embeddedPath = parsed.pathname.slice(firstSlash);
  return `https://${embeddedHost}${embeddedPath}`;
}

function javPosterProxyUrl(value, env = process.env) {
  const source = canonicalJavPosterSource(value);
  const token = encodeSource(source);
  return token ? `${publicBase(env)}/onlyporn/poster/javhdporn/${token}` : value;
}

function cachePaths(sourceUrl, env = process.env) {
  const root = path.join(
    path.resolve(String(env.ONLYPORN_RUNTIME_DIR || '/tmp/onlyporn-runtime')),
    'cache',
    'javhdporn-posters-v2'
  );
  const key = crypto.createHash('sha256').update(sourceUrl).digest('hex');
  return { root, body: path.join(root, `${key}.bin`), meta: path.join(root, `${key}.json`) };
}

function readCached(sourceUrl, env = process.env) {
  const files = cachePaths(sourceUrl, env);
  try {
    const metadata = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
    if (Date.now() - Number(metadata.savedAt || 0) > CACHE_TTL_MS) return null;
    if (!String(metadata.contentType || '').startsWith('image/')) return null;
    const body = fs.readFileSync(files.body);
    if (!body.length || body.length > MAX_IMAGE_BYTES) return null;
    return { body, contentType: metadata.contentType };
  } catch {
    return null;
  }
}

function atomicWrite(filename, data) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function pruneCache(root) {
  let entries;
  try {
    entries = fs.readdirSync(root)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const meta = path.join(root, name);
        const key = name.slice(0, -5);
        const body = path.join(root, `${key}.bin`);
        const stat = fs.statSync(meta);
        const bodyStat = fs.statSync(body);
        return { meta, body, mtimeMs: Math.min(stat.mtimeMs, bodyStat.mtimeMs), bytes: stat.size + bodyStat.size };
      });
  } catch {
    return;
  }
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of entries.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    if (total <= MAX_CACHE_BYTES) break;
    try { fs.unlinkSync(entry.meta); } catch {}
    try { fs.unlinkSync(entry.body); } catch {}
    total -= entry.bytes;
  }
}

function saveCached(sourceUrl, result, env = process.env) {
  const files = cachePaths(sourceUrl, env);
  try {
    fs.mkdirSync(files.root, { recursive: true, mode: 0o700 });
    pruneCache(files.root);
    atomicWrite(files.body, result.body);
    atomicWrite(files.meta, JSON.stringify({ sourceUrl, contentType: result.contentType, savedAt: Date.now() }));
  } catch {
    // Poster caching is best effort. A valid upstream image is still returned.
  }
}

async function fetchImage(sourceUrl) {
  let current = normalizeSourceUrl(sourceUrl);
  if (!current) throw new Error('poster host is not allowed');
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36 Chrome/150 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://www.javhdporn.net/',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      current = normalizeSourceUrl(location ? new URL(location, current).toString() : '');
      if (!current) throw new Error('poster redirect left the allowlist');
      continue;
    }
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].toLocaleLowerCase('en-US');
    if (!contentType.startsWith('image/')) throw new Error('upstream did not return an image');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error('poster exceeds size limit');
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length || body.length > MAX_IMAGE_BYTES) throw new Error('invalid poster size');
    return { body, contentType };
  }
  throw new Error('too many poster redirects');
}

async function loadImage(sourceUrl, env = process.env) {
  const cached = readCached(sourceUrl, env);
  if (cached) return cached;
  if (inFlight.has(sourceUrl)) return inFlight.get(sourceUrl);
  if (inFlight.size >= 32) throw new Error('poster relay is busy');
  const operation = fetchImage(sourceUrl)
    .then(result => {
      saveCached(sourceUrl, result, env);
      return result;
    })
    .finally(() => inFlight.delete(sourceUrl));
  inFlight.set(sourceUrl, operation);
  return operation;
}

function sendImage(response, result) {
  response.status(200);
  response.set('content-type', result.contentType);
  response.set('content-length', String(result.body.length));
  response.set('cache-control', 'public, max-age=21600, stale-while-revalidate=86400');
  response.set('x-content-type-options', 'nosniff');
  response.end(result.body);
}

function installJavHdPornPosterProxyRoute(app, env = process.env) {
  app.get('/onlyporn/poster/javhdporn/:token', async (request, response) => {
    const sourceUrl = decodeSource(request.params.token);
    if (!sourceUrl) return response.status(400).end('invalid poster');
    try {
      return sendImage(response, await loadImage(sourceUrl, env));
    } catch (error) {
      return response.status(502).end(`JAV poster unavailable: ${error.message}`);
    }
  });
}

module.exports = {
  ALLOWED_HOSTS,
  ALLOWED_ROOTS,
  MAX_CACHE_BYTES,
  MAX_IMAGE_BYTES,
  decodeSource,
  encodeSource,
  installJavHdPornPosterProxyRoute,
  javPosterProxyUrl,
  normalizeSourceUrl,
  publicBase,
};
