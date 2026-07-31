#!/usr/bin/env node
'use strict';
const BASE = String(process.env.TPB4K_RENDER_BASE_URL || 'https://onlyporn-v2-public-k143.onrender.com').replace(/\/$/, '');
const EXPECTED = process.env.EXPECTED_VERSION || '2.7.0-alpha.18';
const CONCURRENCY = Math.min(Math.max(Number(process.env.TPB4K_ACCEPTANCE_CONCURRENCY || 4), 1), 8);
const STUDIOS = [
  'brazzersexxtra','cum4k','devilsfilm','digitalplayground','dorcelclub','metart','metartx','milfty','milfy',
  'newsensations','pornmegaload','onlyfans','playboyplus','sexmex','thelifeerotic','vixen','wowgirls','sexart','xvideosred',
].map(name => `tpb4k.studio.${name}.top`);
const BLOCKED = new Set(['gay','interracial']);
const TOP_TAXONOMY = new Set(['hmm-3d','hmm-all','hmm-anime','hmm-censored','hmm-hentai','hmm-new','hmm-raw','hmm-series','hmm-top','hmm-top-rated','hmm-uncensored']);
function fail(message) { throw new Error(message); }
async function json(path, timeoutMs = 45_000) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE}${path}${path.includes('?')?'&':'?'}a18=${Date.now()}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) fail(`${path}: HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function pool(values, worker) {
  let index=0; const errors=[];
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,Math.max(values.length,1))},async()=>{
    while(true){ const i=index++; if(i>=values.length) return; try{ await worker(values[i],i); }catch(e){ errors.push(e); } }
  }));
  if(errors.length) throw errors[0];
}
function boundHash(id) {
  const prefix = 'onlyporn:tpb4k:';
  const value = String(id || '');
  if (!value.startsWith(prefix)) return '';
  try {
    const payload = JSON.parse(Buffer.from(value.slice(prefix.length), 'base64url').toString('utf8'));
    return payload?.v === 2 && /^[a-f0-9]{40}$/i.test(String(payload.h || ''))
      ? String(payload.h).toLowerCase()
      : '';
  } catch { return ''; }
}
function explicitBlocked(meta) {
  const labels=[...(meta.genres||[]),...(meta.tags||[])].map(v=>String(v).trim().toLowerCase());
  return labels.find(label=>BLOCKED.has(label));
}
async function stream(type,id) { return json(`/stream/${type}/${encodeURIComponent(id)}.json`); }
async function meta(type,id) { return json(`/meta/${type}/${encodeURIComponent(id)}.json`); }

(async()=>{
  const manifest=await json('/manifest.json');
  if(manifest.version!==EXPECTED) fail(`Render version ${manifest.version}; expected ${EXPECTED}`);
  console.log(`PASS version ${EXPECTED}`);
  for (const name of ['stream', 'meta']) {
    const resource = (manifest.resources || []).find(item => item && typeof item === 'object' && item.name === name);
    if (!resource || !Array.isArray(resource.idPrefixes) || !resource.idPrefixes.includes('hmm-')) fail(`manifest ${name} resource lacks hmm- idPrefixes`);
  }
  console.log('PASS manifest meta/stream ownership for hmm- IDs');

  let studioCards=0;
  for(const catalogId of STUDIOS){
    const body=await json(`/catalog/movie/${catalogId}.json`); const metas=Array.isArray(body.metas)?body.metas:[];
    if(!metas.length) fail(`${catalogId}: empty; all 19 studios must remain visible`);
    for(const item of metas){ const blocked=explicitBlocked(item); if(blocked) fail(`${catalogId}: explicit blocked label ${blocked}`); }
    await pool(metas,async item=>{ const expectedHash=boundHash(item.id); if(!expectedHash) fail(`${catalogId}: ${item.id} is not a version-2 bound card`); const result=await stream('movie',item.id); const streams=Array.isArray(result.streams)?result.streams:[]; if(!streams.length) fail(`${catalogId}: ${item.id} has no stream`); const returned=streams.map(value=>String(value.infoHash||'').toLowerCase()).filter(Boolean); if(!returned.includes(expectedHash)) fail(`${catalogId}: ${item.id} returned a different hash than its card binding`); });
    studioCards+=metas.length; console.log(`PASS studio ${catalogId}: ${metas.length}/${metas.length} cards returned streams`);
  }

  const sukebei=await json('/catalog/movie/tpb4k.sukebei.top.json');
  const sukebeiMetas=Array.isArray(sukebei.metas)?sukebei.metas:[];
  if(!sukebeiMetas.length) fail('Sukebei is empty');
  await pool(sukebeiMetas,async item=>{ const result=await stream('movie',item.id); if(!Array.isArray(result.streams)||!result.streams.length) fail(`Sukebei ${item.id}: no stream`); });
  console.log(`PASS Sukebei: ${sukebeiMetas.length} playable RSS/metadata cards`);

  for(const mode of ['all','new']){
    const body=await json(`/catalog/series/tpb4k.hentai.${mode}.json`); const metas=Array.isArray(body.metas)?body.metas:[];
    if(!metas.length) fail(`Hentai ${mode}: empty`);
    const sample=[metas[0],metas[Math.floor(metas.length/2)],metas[metas.length-1]].filter((v,i,a)=>v&&a.findIndex(x=>x.id===v.id)===i);
    for(const item of sample){ const m=(await meta('series',item.id)).meta; if(!m||!Array.isArray(m.videos)||!m.videos.length) fail(`Hentai ${mode} ${item.id}: no episodes`); const r=await stream('series',m.videos[0].id); if(!Array.isArray(r.streams)||!r.streams.length) fail(`Hentai ${mode} ${m.videos[0].id}: no stream`); }
    console.log(`PASS Hentai ${mode}: preserved (${metas.length} cards, ${sample.length} sampled)`);
  }

  const topBody=await json('/catalog/series/tpb4k.hentai.top.json'); const top=Array.isArray(topBody.metas)?topBody.metas:[];
  if(!top.length) fail('Hentai Top is empty');
  for(const item of top){ if(TOP_TAXONOMY.has(String(item.id).toLowerCase())) fail(`Hentai Top leaked taxonomy card ${item.id}`); }
  const topDetails=[];
  await pool(top,async item=>{ const m=(await meta('series',item.id)).meta; if(!m||!Array.isArray(m.videos)||!m.videos.length) fail(`Hentai Top ${item.id}: no episode list`); const first=m.videos[0]; const result=await stream('series',first.id); if(!Array.isArray(result.streams)||!result.streams.length) fail(`Hentai Top ${first.id}: no direct stream`); topDetails.push({id:item.id,videos:m.videos}); });
  const deep=[topDetails[0],topDetails[Math.floor(topDetails.length/2)],topDetails[topDetails.length-1]].filter(Boolean);
  for(const item of deep){ const last=item.videos[item.videos.length-1]; const result=await stream('series',last.id); if(!Array.isArray(result.streams)||!result.streams.length) fail(`Hentai Top final episode ${last.id}: no direct stream`); }
  console.log(`PASS Hentai Top: ${top.length}/${top.length} first episodes + ${deep.length} final episodes`);
  console.log(`SUCCESS alpha.18 acceptance: ${studioCards} studio cards, ${sukebeiMetas.length} Sukebei cards, and all three Hentai catalogues.`);
})().catch(error=>{ console.error(`FAIL: ${error.message}`); process.exit(1); });
