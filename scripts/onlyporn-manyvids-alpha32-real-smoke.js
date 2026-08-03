'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveAuthoritativeManyVids,
} = require('../provider/tpb4k/manyvids-authoritative');

const TARGETS = Object.freeze([
  Object.freeze({
    catalog: 'XVideosRED',
    uuid: '17d8775a-7a2f-45e8-8627-2f53d7da50bf',
  }),
  Object.freeze({
    catalog: 'XVideosRED',
    uuid: '69ba4477-be83-4021-b834-e804e773abdf',
  }),
  Object.freeze({
    catalog: 'ThePornDB Recent',
    uuid: '17424e20-1857-432e-844d-bbbd00eb455f',
  }),
  Object.freeze({
    catalog: 'ThePornDB Recent',
    uuid: '3392f14d-4282-43ea-8be3-07b36173964b',
  }),
]);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sceneResource(payload) {
  if (payload?.data && typeof payload.data === 'object') return payload.data;
  if (payload?.scene && typeof payload.scene === 'object') return payload.scene;
  return payload && typeof payload === 'object' ? payload : null;
}

async function fetchScene(apiBase, apiKey, uuid) {
  const response = await fetch(
    `${apiBase.replace(/\/$/, '')}/scenes/${encodeURIComponent(uuid)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'User-Agent': 'OnlyPorn-TPB4K/2.7.0',
      },
    }
  );
  if (!response.ok) throw new Error(`TPDB HTTP ${response.status}`);
  const scene = sceneResource(await response.json());
  if (!scene) throw new Error('TPDB scene was missing');
  if (cleanText(scene.id || scene._id).toLowerCase() !== uuid.toLowerCase()) {
    throw new Error('TPDB returned a different UUID');
  }
  return scene;
}

async function main() {
  const apiKey = cleanText(process.env.TPDB_API_KEY);
  if (!apiKey) throw new Error('TPDB_API_KEY is required');
  const apiBase = cleanText(
    process.env.TPDB_API_BASE || 'https://api.theporndb.net'
  );
  const output = process.env.MANYVIDS_SMOKE_OUT
    ? path.resolve(process.env.MANYVIDS_SMOKE_OUT)
    : path.resolve(process.cwd(), 'manyvids-alpha32-real-smoke.json');

  const rows = [];
  const groupPlayable = {
    XVideosRED: false,
    'ThePornDB Recent': false,
  };
  let fullCount = 0;

  for (const target of TARGETS) {
    const scene = await fetchScene(apiBase, apiKey, target.uuid);
    const item = {
      title: cleanText(scene.title || scene.name),
      performers: Array.isArray(scene.performers) ? scene.performers : [],
      releaseDate: cleanText(scene.release_date || scene.date || scene.releaseDate),
      _rawScene: scene,
    };
    const candidates = await resolveAuthoritativeManyVids({
      item,
      timeoutMs: 20_000,
    });
    const access = candidates.map(candidate =>
      candidate.provenance.includes('manyvids-full-media') ? 'FULL' : 'PREVIEW'
    );
    if (candidates.length) groupPlayable[target.catalog] = true;
    fullCount += access.filter(value => value === 'FULL').length;
    rows.push({
      catalog: target.catalog,
      uuid: target.uuid,
      title: item.title,
      candidates: candidates.length,
      access,
      mediaHosts: candidates.map(candidate => new URL(candidate.url).hostname),
    });
    console.log(
      `${target.catalog} | ${target.uuid} | ${item.title} | ` +
      `${candidates.length ? access.join(',') : 'NO PLAYABLE MEDIA'}`
    );
  }

  const pass = Object.values(groupPlayable).every(Boolean) && fullCount >= 1;
  const report = {
    generatedAt: new Date().toISOString(),
    rows,
    groupPlayable,
    fullCount,
    pass,
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Real smoke report: ${output}`);
  if (!pass) process.exitCode = 3;
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
