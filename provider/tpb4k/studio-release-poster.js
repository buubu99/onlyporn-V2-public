'use strict';

const crypto = require('node:crypto');
const DEFAULT_PUBLIC_BASE = 'https://onlyv2.51-79-157-182.sslip.io';
function compact(value, max = 180) { return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max); }
function publicBase(config = {}, env = process.env) {
  const value = compact(
    config.publicBaseUrl ||
    env.ONLYPORN_PUBLIC_BASE_URL ||
    env.ADDON_BASE_URL ||
    env.PUBLIC_URL ||
    DEFAULT_PUBLIC_BASE
  );
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
  const text=lines(title).map((line,index)=>`<text x="600" y="${260+index*55}" text-anchor="middle" class="title">${escapeXml(line)}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f172a"/><stop offset="1" stop-color="#1e293b"/></linearGradient></defs>
<rect width="1200" height="675" rx="24" fill="url(#g)"/><rect x="26" y="26" width="1148" height="623" rx="22" fill="none" stroke="${accent}" stroke-width="4"/>
<text x="600" y="125" text-anchor="middle" font-family="Arial,sans-serif" font-size="42" font-weight="700" fill="${accent}">${escapeXml(studio || 'OnlyPorn')}</text>
<style>.title{font-family:Arial,sans-serif;font-size:36px;font-weight:600;fill:#f8fafc}</style>${text}
<text x="600" y="560" text-anchor="middle" font-family="Arial,sans-serif" font-size="24" fill="#cbd5e1">PLAYABLE TORRENT RELEASE · METADATA ART PENDING</text>
</svg>`;
}
function installStudioReleasePosterRoute(app) {
  app.get('/onlyporn/poster/studio-release/:hash.svg', (req,res)=>{
    res.setHeader('content-type','image/svg+xml; charset=utf-8'); res.setHeader('cache-control','public, max-age=86400, immutable'); res.setHeader('x-content-type-options','nosniff');
    res.end(renderStudioReleaseSvg(req.params.hash, decode(req.query.s), decode(req.query.t)));
  });
}
module.exports={installStudioReleasePosterRoute,renderStudioReleaseSvg,studioReleasePosterUrl};
