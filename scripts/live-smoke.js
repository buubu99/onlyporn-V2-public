#!/usr/bin/env node

const packageInfo = require('../package.json');

const baseInput = process.argv[2] || process.env.LIVE_BASE_URL || 'https://onlyporn-v2-public-k143.onrender.com';
const expectedVersion = process.argv[3] || process.env.EXPECTED_VERSION || packageInfo.version;
const baseUrl = new URL(baseInput);
const knownEmpty = new Set(
  String(process.env.KNOWN_EMPTY_CATALOGS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const limits = {
  eporner: 60,
  spankbang: 80,
  'xhamster.trending': 40,
  'xhamster.best': 40,
  porntrex: 85,
  xvideos: 50,
  xnxx: 48,
  javhdporn: 24,
  pornhub: 40,
};

function endpoint(pathname) {
  return new URL(pathname, baseUrl).toString();
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${response.status}; invalid JSON: ${text.slice(0, 160)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return data;
}

function providerName(catalogId) {
  return catalogId.split('.')[0];
}

(async () => {
  const failures = [];
  const warnings = [];
  const manifest = await getJson(endpoint('/manifest.json'));

  console.log(`Manifest version: ${manifest.version}`);
  if (manifest.version !== expectedVersion) {
    failures.push(`Expected version ${expectedVersion}, received ${manifest.version}`);
  }

  const catalogs = Array.isArray(manifest.catalogs) ? manifest.catalogs : [];
  console.log(`Catalogs declared: ${catalogs.length}`);
  if (catalogs.length !== 9) failures.push(`Expected 9 catalogs, received ${catalogs.length}`);

  for (const catalog of catalogs) {
    const id = catalog.id;
    const firstUrl = endpoint(`/catalog/movie/${encodeURIComponent(id)}.json?phase6=${Date.now()}`);
    try {
      const first = await getJson(firstUrl);
      const firstMetas = Array.isArray(first.metas) ? first.metas : [];
      const allowedEmpty = knownEmpty.has(id) || knownEmpty.has(providerName(id));

      if (!firstMetas.length) {
        const message = `${id}: empty catalog`;
        if (allowedEmpty) warnings.push(`${message} (known upstream block)`);
        else failures.push(message);
        console.log(`${id}: 0 items`);
        continue;
      }

      const ids = firstMetas.map(item => item.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) failures.push(`${id}: duplicate IDs on page 1`);
      if (firstMetas.some(item => !item.id || !item.name || !item.poster)) {
        failures.push(`${id}: incomplete catalog metadata`);
      }

      const limit = limits[id];
      let pageNote = '';
      if (limit) {
        const secondUrl = endpoint(
          `/catalog/movie/${encodeURIComponent(id)}/skip=${limit}.json?phase6=${Date.now()}`
        );
        const second = await getJson(secondUrl);
        const secondMetas = Array.isArray(second.metas) ? second.metas : [];
        if (secondMetas.length) {
          const firstIds = new Set(ids);
          const overlap = secondMetas.filter(item => firstIds.has(item.id)).length;
          if (overlap === secondMetas.length) failures.push(`${id}: page 2 fully repeats page 1`);
          pageNote = `; page 2=${secondMetas.length}, overlap=${overlap}`;
        } else {
          pageNote = '; page 2 empty';
        }
      }

      console.log(`${id}: page 1=${firstMetas.length}${pageNote}`);
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
      console.log(`${id}: ERROR ${error.message}`);
    }
  }

  for (const warning of warnings) console.warn(`WARNING: ${warning}`);

  if (failures.length) {
    console.error('\nLIVE SMOKE TEST FAILED:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log('\nLIVE SMOKE TEST PASSED.');
  if (warnings.length) console.log(`${warnings.length} known upstream warning(s) were accepted.`);
})().catch(error => {
  console.error(`LIVE SMOKE TEST FAILED: ${error.message}`);
  process.exit(1);
});
