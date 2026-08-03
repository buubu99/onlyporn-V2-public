'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  fullDurationGate,
  resolveAuthoritativeManyVids,
} = require('../provider/tpb4k/manyvids-authoritative');

const API_BASE = String(process.env.TPDB_API_BASE || 'https://api.theporndb.net').replace(/\/$/, '');
const API_KEY = String(process.env.TPDB_API_KEY || '').trim();
const OUT = path.resolve(
  process.env.ALPHA33_SMOKE_OUT || 'alpha33-authoritative-full-manyvids-proof.json'
);

const PROOF_UUIDS = Object.freeze([
  '17d8775a-7a2f-45e8-8627-2f53d7da50bf',
  '69ba4477-be83-4021-b834-e804e773abdf',
  '17424e20-1857-432e-844d-bbbd00eb455f',
  '3392f14d-4282-43ea-8be3-07b36173964b',
]);
const KNOWN_FULL_UUID = '69ba4477-be83-4021-b834-e804e773abdf';
const PREVIEW_ONLY_UUIDS = Object.freeze(
  PROOF_UUIDS.filter(uuid => uuid !== KNOWN_FULL_UUID)
);

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sceneResource(payload) {
  if (payload?.data && typeof payload.data === 'object') return payload.data;
  if (payload?.scene && typeof payload.scene === 'object') return payload.scene;
  if (payload && typeof payload === 'object') return payload;
  return {};
}

function performerNames(scene) {
  return (Array.isArray(scene?.performers) ? scene.performers : [])
    .map(value => clean(
      typeof value === 'string'
        ? value
        : value?.performer?.name || value?.name
    ))
    .filter(Boolean);
}

function studioName(scene) {
  return clean(
    scene?.studio?.name
    || scene?.site?.name
    || scene?.site?.network?.name
    || scene?.site?.parent?.name
  );
}

async function fetchJson(url, headers = {}, timeoutMs = 60_000) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'OnlyPorn-alpha33-authoritative-direct-uuid-proof/1.0',
          ...headers,
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function fetchScene(uuid) {
  const payload = await fetchJson(
    `${API_BASE}/scenes/${encodeURIComponent(uuid)}`,
    { Authorization: `Bearer ${API_KEY}` },
    60_000
  );
  const scene = sceneResource(payload);
  const returned = clean(scene.id || scene._id || scene.uuid).toLowerCase();
  if (returned && returned !== uuid.toLowerCase()) {
    throw new Error(`TPDB returned ${returned} for ${uuid}`);
  }
  if (!clean(scene.title || scene.name)) {
    throw new Error(`TPDB scene ${uuid} has no authoritative title`);
  }
  return scene;
}

function itemFromScene(scene) {
  return {
    title: clean(scene.title || scene.name),
    duration: scene.duration,
    releaseDate: clean(scene.release_date || scene.releaseDate || scene.date),
    studio: studioName(scene),
    performers: performerNames(scene),
    detailUrl: '',
    _rawScene: scene,
  };
}

async function inspectUuid(uuid) {
  const scene = await fetchScene(uuid);
  const item = itemFromScene(scene);
  const candidates = await resolveAuthoritativeManyVids({
    item,
    fetchImpl: globalThis.fetch,
    timeoutMs: 30_000,
  });
  const rows = (Array.isArray(candidates) ? candidates : []).map(candidate => ({
    sourceId: clean(candidate.sourceId),
    title: clean(candidate.title),
    durationSeconds: Number(candidate.durationSeconds) || 0,
    expectedDurationSeconds: Number(candidate.expectedDurationSeconds) || 0,
    contentLength: Number(candidate.contentLength) || 0,
    resolution: clean(candidate.resolution),
    validated: candidate.validated === true,
    provenance: Array.isArray(candidate.provenance) ? candidate.provenance : [],
  }));
  const invalid = rows.filter(row => (
    !row.validated
    || !row.provenance.includes('manyvids-duration-verified')
    || !fullDurationGate(row.durationSeconds, row.expectedDurationSeconds)
    || /preview|teaser/i.test(`${row.sourceId} ${row.title} ${row.provenance.join(' ')}`)
  ));
  return {
    uuid,
    title: item.title,
    variants: rows.length,
    candidates: rows,
    invalidCandidates: invalid.length,
  };
}

async function main() {
  if (!API_KEY) throw new Error('TPDB_API_KEY is required');

  const results = {};
  for (const uuid of PROOF_UUIDS) {
    const result = await inspectUuid(uuid);
    results[uuid] = result;
    console.log(
      `${uuid} | ${result.title} | `
      + `${result.variants ? `${result.variants} DURATION-VERIFIED FULL variant(s)` : 'NO FULL MEDIA'} | `
      + `invalid=${result.invalidCandidates}`
    );
  }

  const knownFull = results[KNOWN_FULL_UUID];
  const previewOnlyRows = PREVIEW_ONLY_UUIDS.map(uuid => results[uuid]);
  const exactUuidGate = Object.keys(results).length === PROOF_UUIDS.length;
  const noInvalidGate = Object.values(results)
    .every(row => row.invalidCandidates === 0);
  const knownFullGate = Boolean(
    knownFull
    && knownFull.variants >= 1
    && knownFull.candidates.every(candidate => (
      candidate.validated
      && candidate.provenance.includes('manyvids-duration-verified')
      && fullDurationGate(candidate.durationSeconds, candidate.expectedDurationSeconds)
    ))
  );
  const previewOnlyFailClosedGate = previewOnlyRows
    .every(row => row.variants === 0);

  const overall = exactUuidGate
    && noInvalidGate
    && knownFullGate
    && previewOnlyFailClosedGate;

  const report = {
    generatedAt: new Date().toISOString(),
    proofMode: 'direct-tpdb-uuid-not-catalog-membership',
    knownFullUuid: KNOWN_FULL_UUID,
    previewOnlyUuids: PREVIEW_ONLY_UUIDS,
    proofScenes: results,
    gates: {
      exactUuidGate,
      noInvalidGate,
      knownFullGate,
      previewOnlyFailClosedGate,
      overall,
    },
  };
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `DIRECT UUID GATE: exact=${exactUuidGate}, no-invalid=${noInvalidGate}, `
    + `known-full=${knownFullGate}, preview-only-fail-closed=${previewOnlyFailClosedGate}`
  );
  console.log(`Proof report: ${OUT}`);
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  process.exitCode = overall ? 0 : 3;
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
