'use strict';

const crypto = require('node:crypto');
const DEFAULT_PUBLIC_BASE = 'https://onlyporn-v2-public-k143.onrender.com';
function compact(value, max = 180) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max); }
function publicBase(config = {}, env = process.env) {
  const value = compact(config.publicBaseUrl || env.ONLYPORN_PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || DEFAULT_PUBLIC_BASE);
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.origin : DEFAULT_PUBLIC_BASE; }
  catch { return DEFAULT_PUBLIC_BASE; }
}
function hash(value) { return crypto.createHash('sha1').update(compact(value) || 'onlyporn').digest('hex'); }
function encode(value) { return Buffer.from(compact(value), 'utf8').toString('base64url'); }
function decode(value) { try { return compact(Buffer.from(String(value || ''), 'base64url').toString('utf8')); } catch { return ''; } }
function studioReleasePosterUrl(item = {}, catalog = {}, config = {}, env = process.env) {
  const token = hash(item.infoHash || item.sourceId || item.title);
  const title = encode(item.title || item.filename || 'OnlyPorn Release');
  const studio = encode(catalog.studio || item.studio || 'OnlyPorn');
  return `${publicBase(config, env)}/onlyporn/poster/studio-release/${token}.svg?s=${studio}&t=${title}`;
}
function escapeXml(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;' }[char])); }
function lines(value, width = 30, maxLines = 4) {
  const words = compact(value).split(/\s+/).filter(Boolean); const out=[]; let line='';
  for (const word of words) { const next=line?`${line} ${word}`:word; if (next.length>width&&line){out.push(line);line=word;}else line=next; if(out.length>=maxLines)break; }
  if(line&&out.length<maxLines)out.push(line); if(!out.length)out.push('OnlyPorn Release'); return out;
}
function renderStudioReleaseSvg(hashValue, studio, title) {
  const accent = ['#22c55e','#06b6d4','#8b5cf6','#f97316'][Number.parseInt(hash(hashValue).slice(0,2),16)%4];
  const titleLines = lines(title, 24, 6).map((line,index)=>`<text x="300" y="${350+index*54}" text-anchor="middle" class="title">${escapeXml(line)}</text>`).join('');
  const studioLabel = compact(studio || 'OnlyPorn', 34);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#211542"/></linearGradient><pattern id="p" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="8" height="28" fill="${accent}" opacity=".08"/></pattern></defs>
<rect width="600" height="900" rx="28" fill="url(#g)"/><rect width="600" height="900" rx="28" fill="url(#p)"/><rect x="24" y="24" width="552" height="852" rx="24" fill="none" stroke="${accent}" stroke-width="4"/>
<text x="300" y="92" text-anchor="middle" font-family="Arial,sans-serif" font-size="27" font-weight="800" fill="#f8fafc">ONLYPORN</text>
<text x="300" y="136" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="600" fill="${accent}">${escapeXml(studioLabel)}</text>
<circle cx="300" cy="235" r="62" fill="none" stroke="${accent}" stroke-width="6"/><text x="300" y="252" text-anchor="middle" font-family="Arial,sans-serif" font-size="42" font-weight="800" fill="#fff">${escapeXml(studioLabel.split(/\s+/).map(v=>v[0]).join('').slice(0,3).toUpperCase() || 'OP')}</text>
<style>.title{font-family:Arial,sans-serif;font-size:34px;font-weight:700;fill:#f8fafc}</style>${titleLines}
<line x1="90" y1="720" x2="510" y2="720" stroke="${accent}" opacity=".55"/>
<text x="300" y="770" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#cbd5e1">PLAYABLE RELEASE</text>
<text x="300" y="810" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="#94a3b8">Scene artwork pending · exact torrent preserved</text>
</svg>`;
}
function installStudioReleasePosterRoute(app) {
  app.get('/onlyporn/poster/studio-release/:hash.svg', (req,res)=>{
    res.setHeader('content-type','image/svg+xml; charset=utf-8'); res.setHeader('cache-control','public, max-age=86400, immutable'); res.setHeader('x-content-type-options','nosniff');
    res.end(renderStudioReleaseSvg(req.params.hash, decode(req.query.s), decode(req.query.t)));
  });
}
module.exports={installStudioReleasePosterRoute,renderStudioReleaseSvg,studioReleasePosterUrl};
