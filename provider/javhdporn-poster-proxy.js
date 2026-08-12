'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PUBLIC_BASE = 'https://onlyv2.51-79-157-182.sslip.io';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_CACHE_BYTES = 192 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ALLOWED_ROOTS = Object.freeze(['javhdporn.net', 'pornfhd.com']);
const ALLOWED_HOSTS = Object.freeze(['i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'i3.wp.com']);
const DIRECT_IMAGE_HOSTS = Object.freeze(['pics.dmm.co.jp']);
const FC2_STORAGE_HOST = /^storage\d+\.contents\.fc2\.com$/i;
const inFlight = new Map();

const FALLBACK_POSTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAlgAAAOECAIAAADyj9hrAAAs0UlEQVR42u3deXxV5YHw8ZuELEAIiyDKvoVNkUUEohYEQRbZsZ+3bxe7OWPn7TJj+3baqXVmWrUdbd/XGTuOnRmxU7DVtrLJKiCyCIR9k0X2PSCbhOxkef9gyhvvDbknGwTy/X76R705uZycnNzffc59zjkxbdp0CAFAXRVrEwAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQBCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCABCCIAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAoAQAiCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEAAihTQCAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAIghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAIIQAIIQAIIQAIIQAIIQAIIQAIIQDcuurZBHXKZz/72HPP/STIko88MvrIkaPX+R+9oqSk5OGHR544cSLg8k888bXvf/97QZYcPnzksWPHq3F7fuEL//Pv//7HQZacMGHynj0f3ey/2ZUrl7Vs2TLqYgsWLHzqqf9dvTtGSUlJcXFxcXHx5cuX8/Pz8/MLcnJysrKyMjMzL1y4cO7c+YyMjIyMjMOHjxw5cjQvL88fO0JILTJ58sQKLR8TEzNp0oR//dd/C7j87NnvfPe7fxMXFxd1yfHjx73yyqvV+KONHz8uyGJ79nxUoxWsC2JiYuLi4uLi4uLj4xs0aFDOkkVFRQcPHtq2bVt6+rr331+RlZVl61E+h0apWe3bt+vXr29Fv2vixAkxMTEBFz579uwHH6wONiwbX70/Wp8+vYMsOXPmbHvCdRMXF5ea2uWxx6b88pcvrlmz8uWX/3nYsKHBdyeEEKrZxIkTKvFdbdu26d//3uDLByxN8HRV43CwqKho7tx59oQbIjExceTIEa+++q9z584aM2Z0bKxXPISQ6ysmJmbixEoOwiZNmhh84WXL3s/MzAw2KBxXXT9dwBCuWLHy/PnzdoYbKzU19aWXfvn730/v1KmjrYEQcv0MGjSwVatWlfve0aNH1q9fP+DCBQUF8+cvCLLkmDGj69Wrho/G+/bt065d22ocrXId9O3bZ86cmV/96pdtCoSQ62TSpAmV/t4GDRo8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c889d617kd+Mli9fHrlxRo0aXenx2U9+8pO1a9dELdOFCxemTfvtf/zHf1R9mH7mzJmVK1eWv0zPnndFHkiI+l179uw+c+ZM1CHRtcZ8V6xdu7as24HV7PrUkFqy2sXFxcuXL3/hhRduvav+3jIcGq1xRUVFK1asWLVqVbdu3bt3756amtq0adPk5IZJSfVzcnKys7POnTu3d+/e3bv3RB075ufnr169evXq1YmJiV27dk1NTW3VqlXLlnekpKQkJSXFxsbm5eVlZ2efPHny8OHDGzduKH1lr1tDbm7uypUrRo4cVfrB9u3b9+zZ8+p1IyskKyvrtddemzFjRv/+/bt0SW3btk3Dhsn169cvKirKycn55JNPDh48uGfP7q1bt0aNZXBz577zwAMPhE3V+fTLbvix00OHDkW9m11JScmqVasmT55c+sEBA+57883fh80UPXToUOTMoz+HcM31X58acqNW+/Lly/n5+Z98cuHkyYx9+/Zu2rTJEdFaLqZNmw62AgB1lkOjAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAFRUPZugtHHjptgIQF0wd+4MG8GIEACEEAAhBAAhBAAhBAAhBIC6I6ZNmw62AgBGhAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAghAAIoU0AgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACgBACIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQAIIQACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEACCEAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQggAQgiAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAKAEAIghDYBAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAEIIAFXz/wCjJJqU8V67sAAAAABJRU5ErkJggg==',
  'base64'
);
const FALLBACK_POSTER_TOKEN = 'fallback.png';

function allowedHost(hostname) {
  const host = String(hostname || '').toLocaleLowerCase('en-US');
  return ALLOWED_HOSTS.includes(host) || DIRECT_IMAGE_HOSTS.includes(host) || FC2_STORAGE_HOST.test(host) ||
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
      const embedded = parsed.pathname.match(
        /^\/(storage\d+\.contents\.fc2\.com|pics\.dmm\.co\.jp)(\/.*)$/i
      );
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

function javPosterProxyUrl(value, env = process.env) {
  const token = encodeSource(value);
  return token
    ? `${publicBase(env)}/onlyporn/poster/javhdporn/${token}`
    : `${publicBase(env)}/onlyporn/poster/javhdporn/${FALLBACK_POSTER_TOKEN}`;
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

function sendFallbackImage(response) {
  response.set('x-onlyporn-poster-fallback', '1');
  return sendImage(response, {
    body: FALLBACK_POSTER_PNG,
    contentType: 'image/png',
  });
}

function installJavHdPornPosterProxyRoute(app, env = process.env) {
  app.get('/onlyporn/poster/javhdporn/:token', async (request, response) => {
    if (request.params.token === FALLBACK_POSTER_TOKEN) {
      return sendFallbackImage(response);
    }

    const sourceUrl = decodeSource(request.params.token);
    if (!sourceUrl) return sendFallbackImage(response);

    try {
      return sendImage(response, await loadImage(sourceUrl, env));
    } catch {
      // Catalog artwork is non-critical UI data. If an upstream image disappears,
      // preserve the card and return deterministic local artwork instead of 502.
      return sendFallbackImage(response);
    }
  });
}

module.exports = {
  ALLOWED_HOSTS,
  ALLOWED_ROOTS,
  FALLBACK_POSTER_PNG,
  FALLBACK_POSTER_TOKEN,
  MAX_CACHE_BYTES,
  MAX_IMAGE_BYTES,
  decodeSource,
  encodeSource,
  installJavHdPornPosterProxyRoute,
  javPosterProxyUrl,
  normalizeSourceUrl,
  publicBase,
};
