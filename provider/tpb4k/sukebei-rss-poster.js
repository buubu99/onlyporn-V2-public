'use strict';

const crypto = require('node:crypto');

const DEFAULT_PUBLIC_BASE = 'https://onlyporn-v2-public-k143.onrender.com';

function publicBase(env = process.env) {
  const value = String(env.ONLYPORN_PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || DEFAULT_PUBLIC_BASE).trim();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return DEFAULT_PUBLIC_BASE;
    return parsed.origin;
  } catch { return DEFAULT_PUBLIC_BASE; }
}
function compact(value, length = 140) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, length); }
function encodedTitle(value) { return Buffer.from(compact(value), 'utf8').toString('base64url'); }
function decodedTitle(value) {
  try { return compact(Buffer.from(String(value || ''), 'base64url').toString('utf8')); }
  catch { return ''; }
}
function safeHash(value) {
  const hash = String(value || '').toLowerCase();
  return /^[a-f0-9]{40}$/.test(hash) ? hash : crypto.createHash('sha1').update(hash || 'sukebei').digest('hex');
}
function sukebeiRssPosterUrl(item = {}, config = {}, env = process.env) {
  const hash = safeHash(item.infoHash || item.sourceId || item.title);
  const title = encodedTitle(item.title || item.filename || 'Sukebei RSS');
  const base = String(config.publicBaseUrl || publicBase(env)).replace(/\/$/, '');
  return `${base}/onlyporn/poster/sukebei-rss/${hash}.svg?t=${title}`;
}
function escapeXml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
}
function wrapTitle(value, max = 25, lines = 5) {
  const words = compact(value, 180).split(/\s+/).filter(Boolean);
  const output = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) { output.push(current); current = word; }
    else current = next;
    if (output.length >= lines) break;
  }
  if (current && output.length < lines) output.push(current);
  if (!output.length) output.push('Sukebei RSS');
  if (words.join(' ').length > output.join(' ').length) output[output.length - 1] = `${output[output.length - 1].slice(0, Math.max(max - 1, 1))}…`;
  return output;
}
function renderSukebeiRssSvg(hash, title) {
  const lines = wrapTitle(title, 34, 3);
  const accents = ['#6d5dfc', '#a855f7', '#ec4899', '#14b8a6'];
  const accent = accents[Number.parseInt(safeHash(hash).slice(0, 2), 16) % accents.length];
  const text = lines.map((line, index) => `<text x="610" y="${250 + index * 58}" text-anchor="middle" class="title">${escapeXml(line)}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#121027"/><stop offset="1" stop-color="#241d48"/></linearGradient></defs>
  <rect width="1200" height="675" rx="24" fill="url(#g)"/>
  <rect x="28" y="28" width="1144" height="619" rx="22" fill="none" stroke="${accent}" stroke-width="4" opacity=".9"/>
  <circle cx="180" cy="198" r="88" fill="none" stroke="${accent}" stroke-width="8"/>
  <text x="180" y="226" text-anchor="middle" font-family="Arial,sans-serif" font-size="72" font-weight="700" fill="#fff">SU</text>
  <text x="180" y="350" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="${accent}">SUKEBEI RSS</text>
  <style>.title{font-family:Arial,sans-serif;font-size:34px;font-weight:600;fill:#f8fafc}</style>
  ${text}
  <text x="610" y="510" text-anchor="middle" font-family="Arial,sans-serif" font-size="23" fill="#cbd5e1">PLAYABLE RSS TORRENT · ARTWORK PENDING</text>
  <text x="610" y="555" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" fill="#94a3b8">OnlyPorn-owned fallback · exact torrent identity preserved</text>
</svg>`;
}

function installSukebeiPosterRoute(app) {
  app.get('/onlyporn/poster/sukebei-rss/:hash.svg', (req, res) => {
    const hash = safeHash(req.params.hash);
    const title = decodedTitle(req.query.t) || 'Sukebei RSS';
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(renderSukebeiRssSvg(hash, title));
  });
}

module.exports = {
  decodedTitle,
  installSukebeiPosterRoute,
  publicBase,
  renderSukebeiRssSvg,
  sukebeiRssPosterUrl,
};
