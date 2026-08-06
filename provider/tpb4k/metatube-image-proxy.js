'use strict';

const crypto = require('node:crypto');
const { validateImageResponse } = require('./sukebei-image-validator');

const MAX_IMAGE_BYTES = 2_000_000;
const MAX_CONCURRENT_IMAGES = 2;
const MAX_WAITING_IMAGES = 20;
let activeImages = 0;
const imageWaiters = [];

function compactText(value, max = 500) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
}

function proxySignature(secret, provider, id) {
  return crypto.createHmac('sha256', compactText(secret, 500))
    .update(`${compactText(provider, 300)}\0${compactText(id, 300)}`, 'utf8')
    .digest('base64url');
}

function validSignature(secret, provider, id, supplied) {
  if (compactText(secret, 500).length < 32) return false;
  const expected = Buffer.from(proxySignature(secret, provider, id));
  const actual = Buffer.from(compactText(supplied, 200));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function decodeToken(value) {
  try {
    const decoded = Buffer.from(String(value || ''), 'base64url').toString('utf8').normalize('NFKC').trim();
    return decoded && decoded.length <= 300 ? decoded : '';
  } catch {
    return '';
  }
}

function internalBase(env = process.env) {
  try {
    const url = new URL(String(env.TPB4K_METATUBE_URL || 'http://127.0.0.1:18080').trim());
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

async function readBoundedBody(response, maxBytes = MAX_IMAGE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('MetaTube poster exceeds the byte limit');
  }
  if (!response.body?.getReader) throw new Error('MetaTube poster response is not streamable');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        await reader.cancel('MetaTube poster exceeds the byte limit');
        throw new Error('MetaTube poster exceeds the byte limit');
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks, total);
}

async function fetchImage(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5',
        'User-Agent': 'OnlyPorn-MetaTube-Poster-Proxy/1.0',
      },
    });
    if (!response.ok) return { response, bytes: null };
    return { response, bytes: await readBoundedBody(response) };
  } finally {
    clearTimeout(timer);
  }
}

async function withImageSlot(operation) {
  if (activeImages >= MAX_CONCURRENT_IMAGES) {
    if (imageWaiters.length >= MAX_WAITING_IMAGES) throw new Error('MetaTube poster proxy is busy');
    await new Promise(resolve => imageWaiters.push(resolve));
  }
  activeImages += 1;
  try {
    return await operation();
  } finally {
    activeImages -= 1;
    imageWaiters.shift()?.();
  }
}

function installMetaTubeImageProxyRoute(app, env = process.env) {
  app.get('/onlyporn/poster/metatube/:provider/:id/:signature', async (req, res) => {
    const base = internalBase(env);
    const provider = decodeToken(req.params.provider);
    const id = decodeToken(req.params.id);
    const secret = String(env.TPB4K_METATUBE_PROXY_SECRET || '');
    if (!base || !provider || !id) {
      res.statusCode = 400;
      res.end('Invalid MetaTube poster reference');
      return;
    }
    if (!validSignature(secret, provider, id, req.params.signature)) {
      res.statusCode = 403;
      res.end('Invalid MetaTube poster signature');
      return;
    }

    const url = `${base}/v1/images/primary/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`;
    try {
      const { response, bytes } = await withImageSlot(() => fetchImage(
        url,
        Math.min(Math.max(Number(env.TPB4K_METATUBE_IMAGE_TIMEOUT_MS || 30_000), 5_000), 90_000)
      ));
      if (!response.ok || !bytes) {
        res.statusCode = response.status === 404 ? 404 : 502;
        res.end('MetaTube poster unavailable');
        return;
      }
      const validation = await validateImageResponse(new Response(bytes, {
        status: 200,
        headers: { 'content-type': response.headers.get('content-type') || 'application/octet-stream' },
      }), { url, maxResponseBytes: MAX_IMAGE_BYTES });
      if (!validation.valid) {
        res.statusCode = 502;
        res.end('Invalid MetaTube poster');
        return;
      }
      const type = validation.format === 'png'
        ? 'image/png'
        : validation.format === 'webp'
          ? 'image/webp'
          : validation.format === 'avif'
            ? 'image/avif'
            : 'image/jpeg';
      res.setHeader('content-type', type);
      res.setHeader('content-length', String(bytes.length));
      res.setHeader('cache-control', 'public, max-age=21600, stale-while-revalidate=86400');
      res.setHeader('x-content-type-options', 'nosniff');
      res.end(bytes);
    } catch (error) {
      res.statusCode = /busy/i.test(String(error?.message || '')) ? 503 : 502;
      res.end('MetaTube poster proxy error');
    }
  });
}

module.exports = {
  MAX_CONCURRENT_IMAGES,
  MAX_IMAGE_BYTES,
  decodeToken,
  installMetaTubeImageProxyRoute,
  proxySignature,
  readBoundedBody,
  validSignature,
};
