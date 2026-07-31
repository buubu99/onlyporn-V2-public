#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { auditReleaseVersionAssertions, listTestFiles } = require('./release-version-consistency');
const { audit: auditZeroDependency } = require('./audit-zero-comparison-dependency');

const root = path.resolve(process.argv[2] || process.cwd());
const packageRoot = __dirname === path.join(root, 'tools') ? root : path.resolve(__dirname, '..');
const BASE_VERSION = '2.7.0-alpha.18';
const TARGET_VERSION = '2.7.0-alpha.20';
const BASE_FINGERPRINT = 'ONLYPORN-A18-R3-ALL-RELEASE-VERSIONS-20260731';
const TARGET_FINGERPRINT = 'ONLYPORN-A20-FINAL-IMMUTABLE-CACHE-ISOLATION-20260731';

function fail(message) { throw new Error(message); }
function read(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) fail(`Required file is missing: ${relative}`);
  return fs.readFileSync(file, 'utf8');
}
function write(relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}
function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) fail(`${label}: expected one patch anchor; found ${count}`);
  return source.replace(before, after);
}
function replaceFunction(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) fail(`${label}: function anchors missing`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}
function copyPackageFile(relative) {
  const source = path.join(packageRoot, relative);
  if (!fs.existsSync(source)) fail(`Alpha.20 package file is missing: ${relative}`);
  const target = path.join(root, relative);
  if (path.resolve(source) === path.resolve(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function verifyBase() {
  const pkg = JSON.parse(read('package.json'));
  if (pkg.version !== BASE_VERSION) fail(`Alpha.20 requires ${BASE_VERSION}; found ${pkg.version}`);
  if (read('A18R3_FINGERPRINT.txt').trim() !== BASE_FINGERPRINT) fail('Alpha.20 requires the exact Alpha.18 R3 fingerprint');
}
function removeObsoleteComparisonCoupling() {
  for (const relative of [
    'tools/apply-all-19-playable-binding.js',
    'tools/apply-alpha17.js',
    'tools/apply-alpha18.js',
    'tools/apply-alpha19.js',
    'tools/patch-aiostreams-config-alpha17.js',
    'scripts/tpb4k-alpha17-acceptance.js',
    'scripts/tpb4k-alpha18-acceptance.js',
    'scripts/onlyporn-alpha19-acceptance.js',
  ]) {
    const target = path.join(root, relative);
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
}
function installFullReplacements() {
  for (const relative of [
    'A20_FINGERPRINT.txt',
    'ONLYPORN_ALPHA20_FINAL.md',
    'provider/tpb4k.js',
    'provider/tpb4k/id-codec.js',
    'provider/tpb4k/knaben.js',
    'provider/tpb4k/source-contract.js',
    'provider/tpb4k/studio-aliases.js',
    'provider/tpb4k/studio-playback-binding.js',
    'provider/tpb4k/studio-targeted-recovery.js',
    'provider/tpb4k/hentaimama-series.js',
    'provider/tpb4k/sukebei-rss-poster.js',
    'provider/tpb4k/sukebei-artwork-store.js',
    'provider/tpb4k-alpha19.test.js',
    'provider/tpb4k-alpha18-regression.test.js',
    'provider/tpb4k-hentaimama-series.test.js',
    'provider/tpb4k-all-19-playable-binding.test.js',
    'provider/onlyporn-alpha20-final.test.js',
    'scripts/onlyporn-alpha20-acceptance.js',
    'tools/apply-alpha20.js',
    'tools/audit-zero-comparison-dependency.js',
    'tools/release-version-consistency.js',
  ]) copyPackageFile(relative);
}
function patchCatalog() {
  let source = read('catalog/tpb4k.js');
  for (const id of ['tpb4k.hentai.all', 'tpb4k.hentai.new', 'tpb4k.hentai.top']) {
    const start = source.indexOf(`    id: '${id}',`);
    if (start < 0) fail(`Hentai catalog missing: ${id}`);
    const end = source.indexOf('  },', start);
    const block = source.slice(start, end);
    if (!block.includes("type: 'series'")) {
      const lineEnd = source.indexOf('\n', start);
      source = `${source.slice(0, lineEnd + 1)}    type: 'series',\n${source.slice(lineEnd + 1)}`;
    }
  }
  if (!source.includes("id: 'tpb4k.sukebei.rss'")) {
    const start = source.indexOf("    id: 'tpb4k.sukebei.top',");
    if (start < 0) fail('Sukebei Top catalog anchor missing');
    const end = source.indexOf('  },', start);
    if (end < 0) fail('Sukebei Top catalog end missing');
    const insertAt = end + 4;
    const definition = `\n  {\n    id: 'tpb4k.sukebei.rss',\n    name: 'OnlyPorn: Sukebei · RSS Playable',\n    source: 'sukebei',\n    mode: 'rss',\n  },`;
    source = `${source.slice(0, insertAt)}${definition}${source.slice(insertAt)}`;
  }
  source = source.replace("    type: 'movie',\n    name: definition.name,", "    type: definition.type || 'movie',\n    name: definition.name,");
  write('catalog/tpb4k.js', source);
}
function patchAddon() {
  let source = read('addon.js');
  const target = "idPrefixes: ['onlyporn:', 'ophmm-']";
  if (!source.includes(target)) {
    const previous = "idPrefixes: ['onlyporn:', '" + "h" + "mm-']";
    const occurrences = source.split(previous).length - 1;
    if (occurrences !== 2) fail(`Expected two Alpha.18 resource-prefix anchors; found ${occurrences}`);
    source = source.replaceAll(previous, target);
  }
  if ((source.split(target).length - 1) !== 2) fail('Exclusive OnlyPorn resource ownership was not installed twice');
  if (/idPrefixes:\s*\[[^\]]*(['"`])hmm-/i.test(source)) fail('Shared Hentai resource prefix remains');
  write('addon.js', source);
}
function patchCandidate() {
  let source = read('provider/tpb4k/candidate.js');
  source = source.replace(/TPB 4K ·/g, 'OnlyPorn ·');
  source = source.replace(/TPB 4K result/g, 'OnlyPorn result');
  source = source.replace(/onlyporn-tpb4k-/g, 'onlyporn-torrent-');
  source = source.replace("source: cleanText(input.source || 'unknown').toLowerCase(),", "source: cleanText(input.source || input.indexer || 'unknown').toLowerCase(),");
  if (!source.includes('const INDEXER_RELIABILITY')) {
    source = replaceOnce(source, "const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';\n", `const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';\nconst INDEXER_RELIABILITY = Object.freeze({\n  pornrips: 100,\n  sukebei: 96,\n  '1337x': 92,\n  hiddenbay: 88,\n  piratebay: 88,\n  tpb: 88,\n  knaben: 84,\n  unknown: 50,\n});\n`, 'candidate reliability constants');
  }
  if (!source.includes('function indexerReliability(value)')) {
    source = replaceOnce(source, 'function normalizeSeeders(value) {\n', `function indexerReliability(value) {\n  const key = cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');\n  if (!key) return INDEXER_RELIABILITY.unknown;\n  if (key.includes('pornrips')) return INDEXER_RELIABILITY.pornrips;\n  if (key.includes('sukebei')) return INDEXER_RELIABILITY.sukebei;\n  if (key.includes('1337')) return INDEXER_RELIABILITY['1337x'];\n  if (key.includes('hiddenbay')) return INDEXER_RELIABILITY.hiddenbay;\n  if (key.includes('piratebay')) return INDEXER_RELIABILITY.piratebay;\n  if (key === 'tpb') return INDEXER_RELIABILITY.tpb;\n  if (key.includes('knaben')) return INDEXER_RELIABILITY.knaben;\n  return INDEXER_RELIABILITY.unknown;\n}\nfunction normalizeSeeders(value) {\n`, 'candidate reliability function');
  }
  const oldScore = `    Math.min(candidate.seeders, 99_999) * 1_000 +\n    Math.min(Math.floor(candidate.size / (1024 * 1024)), 999)`;
  const newScore = `    Math.min(candidate.seeders, 99_999) * 1_000 +\n    indexerReliability(candidate.source) * 10 +\n    Math.min(Math.floor(candidate.size / (1024 * 1024)), 9)`;
  if (source.includes(oldScore)) source = replaceOnce(source, oldScore, newScore, 'candidate reliability score');
  if (!source.includes('indexerReliability(candidate.source) * 10')) fail('Candidate reliability score is missing');
  if (!source.includes('  indexerReliability,\n')) source = replaceOnce(source, '  dedupeCandidates,\n', '  dedupeCandidates,\n  indexerReliability,\n', 'candidate reliability export');
  write('provider/tpb4k/candidate.js', source);
}
function patchTorrentIndex() {
  let source = read('provider/tpb4k/torrent-index.js');
  const sceneQueries = `  function sceneQueries(item = {}, catalog = {}) {\n    const identity = buildSceneIdentity(item);\n    const studio = compactText(item.studio || catalog.studio);\n    const studioKey = compactComparable(studio);\n    const title = normalizeSearchTitle(item.title, studio).query;\n    const identities = [\n      item.creator, item.username, item.channel, item.account, item.model, item.performer,\n      ...(Array.isArray(item.performers) ? item.performers : []),\n    ].map(compactText).filter(value => value.length >= 3);\n    const creator = identities[0] || '';\n    const platform = studioKey === 'onlyfans';\n    const values = [\n      identity.sceneCode,\n      platform ? [creator, title, 'OnlyFans'].map(compactText).filter(Boolean).join(' ') : [studio, title].map(compactText).filter(Boolean).join(' '),\n      compactText(item.lookupQuery),\n      platform ? [creator, title].map(compactText).filter(Boolean).join(' ') : '',\n    ];\n    const output = [];\n    const seen = new Set();\n    for (const value of values) {\n      const query = compactText(value).slice(0, 180);\n      const key = query.toLowerCase();\n      if (query.length < 3 || seen.has(key)) continue;\n      seen.add(key);\n      output.push(query);\n      if (output.length >= 3) break;\n    }\n    return output;\n  }\n`;
  source = replaceFunction(source, '  function sceneQueries(item = {}, catalog = {}) {', '  function compactComparable(value) {', sceneQueries, 'sceneQueries');
  const matcher = `  function recordMatchesScene(record, item = {}, catalog = {}) {\n    const identity = buildSceneIdentity(item);\n    const recordKey = compactComparable(record.title);\n    const codeKey = compactComparable(identity.sceneCode);\n    if (codeKey) return recordKey.includes(codeKey);\n    const studio = compactText(item.studio || catalog.studio);\n    const studioKey = compactComparable(studio);\n    const targeted = Boolean(catalog?.targetedPlaybackSearch);\n    const platform = studioKey === 'onlyfans';\n    const studioEvidence = Boolean(studioKey && recordKey.includes(studioKey));\n    const expectedTokens = significantTokens(item.title, studio)\n      .filter(token => !platform || !['onlyfans', 'only', 'fans', 'fansly', 'fanvue'].includes(String(token).toLowerCase()));\n    const actualTokens = new Set(significantTokens(record.title, studio));\n    const identityKeys = [\n      item.creator, item.username, item.channel, item.account, item.model, item.performer,\n      ...(Array.isArray(item.performers) ? item.performers : []),\n    ].map(compactComparable).filter(value => value.length >= 4);\n    const identityEvidence = identityKeys.some(value => recordKey.includes(value));\n    if (!expectedTokens.length) return false;\n    const overlap = expectedTokens.filter(token => actualTokens.has(token)).length;\n    const coverage = overlap / expectedTokens.length;\n    if (platform) return overlap >= 2 && coverage >= 0.45 && identityEvidence;\n    if (expectedTokens.length === 1) return expectedTokens[0].length >= 3 && overlap === 1 && (studioEvidence || targeted);\n    return coverage >= 0.75 && (studioEvidence || targeted || coverage === 1);\n  }\n`;
  source = replaceFunction(source, '  function recordMatchesScene(record, item = {}, catalog = {}) {', '  async function searchIndexers(', matcher, 'recordMatchesScene');
  if (!source.includes("source: 'knaben-targeted'")) {
    source = replaceOnce(source, '    const searches = [\n', `    const searches = [\n      {\n        source: 'knaben-targeted',\n        run: async () => ({\n          records: await knabenClient.searchStudio(query, { orderBy: 'seeders', targeted: true }),\n          mirror: knabenClient.endpointOrigin,\n        }),\n      },\n`, 'targeted Knaben search');
  }
  write('provider/tpb4k/torrent-index.js', source);
}
function patchStudioMetadata() {
  let source = read('provider/tpb4k/studio-metadata.js');
  if (!source.includes('function platformIdentityFields(')) {
    const anchor = 'function bindCatalogIdentity(provider, rawScene, normalized, studio) {\n';
    const helper = `function identityText(value, fields = ['name', 'username', 'handle', 'title']) {\n  if (value && typeof value === 'object') {\n    for (const field of fields) {\n      const text = compactText(value[field]);\n      if (text) return text;\n    }\n    return '';\n  }\n  return compactText(value);\n}\nfunction platformIdentityFields(scene = {}, normalized = {}, studio = '') {\n  if (compactKey(studio) !== 'onlyfans') return Object.freeze({});\n  const creator = [scene.creator, scene.model, scene.performer, scene.user, scene.account, ...(Array.isArray(normalized.performers) ? normalized.performers : [])]\n    .map(value => identityText(value)).find(Boolean) || '';\n  const username = [scene.username, scene.handle, scene.creator, scene.user, scene.account]\n    .map(value => identityText(value, ['username', 'handle', 'name'])).find(Boolean) || '';\n  const channel = identityText(scene.channel, ['name', 'username', 'handle']);\n  const account = identityText(scene.account, ['username', 'handle', 'name']);\n  return Object.freeze({ creator, username, channel, account });\n}\nfunction bindCatalogIdentity(provider, rawScene, normalized, studio) {\n`;
    source = replaceOnce(source, anchor, helper, 'platform identity helper');
  }
  const oldQuery = `  const requestedStudio = normalizeStudioName(studio);\n  const lookupQuery = [requestedStudio, normalized.releaseDate, normalized.sceneCode, normalized.title]`;
  const newQuery = `  const requestedStudio = normalizeStudioName(studio);\n  const platformIdentity = platformIdentityFields(rawScene, normalized, requestedStudio);\n  const lookupQuery = [requestedStudio, platformIdentity.creator, platformIdentity.username, platformIdentity.channel, platformIdentity.account, normalized.releaseDate, normalized.sceneCode, normalized.title]`;
  if (source.includes(oldQuery)) source = replaceOnce(source, oldQuery, newQuery, 'OnlyFans lookup query identities');
  if (!source.includes('    ...platformIdentity,\n')) source = replaceOnce(source, '    ...normalized,\n    studio: requestedStudio,', '    ...normalized,\n    ...platformIdentity,\n    studio: requestedStudio,', 'platform identity fields');
  if (!source.includes('  platformIdentityFields,\n')) source = replaceOnce(source, '  parseSourceId,\n', '  parseSourceId,\n  platformIdentityFields,\n', 'platform identity export');
  write('provider/tpb4k/studio-metadata.js', source);
}
function patchSukebei() {
  let source = read('provider/tpb4k/sukebei-metadata.js');
  if (!source.includes("require('./sukebei-rss-poster')")) {
    const firstUse = source.indexOf("require('./poster-enrichment')");
    if (firstUse < 0) fail('Sukebei poster-enrichment import anchor missing');
    const lineEnd = source.indexOf('\n', firstUse);
    source = `${source.slice(0, lineEnd + 1)}const { sukebeiRssPosterUrl } = require('./sukebei-rss-poster');\n${source.slice(lineEnd + 1)}`;
  }
  if (!source.includes("require('./sukebei-artwork-store')")) {
    source = replaceOnce(source, "const { BoundedTtlCache } = require('./cache');\n", "const { BoundedTtlCache } = require('./cache');\nconst { createSukebeiArtworkStore } = require('./sukebei-artwork-store');\n", 'Sukebei artwork store import');
  }
  source = source.replace('    if (allowed.length < needed) {', "    if (catalog?.mode === 'rss' && allowed.length < needed) {");
  source = source.replace("      const poster = fallbackPosterUrl('sukebei', config.posterAssetBaseUrl);\n", '');
  source = source.replace('          poster,\n          background: poster,', "          poster: sukebeiRssPosterUrl(source, config),\n          background: sukebeiRssPosterUrl(source, config),");
  if (!source.includes('const artworkStore = options.artworkStore')) {
    source = replaceOnce(source, '  const index = new Map();\n', `  const index = new Map();\n  const artworkStore = options.artworkStore || createSukebeiArtworkStore({\n    env: options.env || process.env,\n    maxEntries: Math.max(Number(config.metadataCacheMaxEntries || 500), 50),\n  });\n`, 'Sukebei artwork store construction');
  }
  const statsPattern = /^(\s*)cacheHits: 0,\n\1providerRequests:/gm;
  let blocks = 0;
  source = source.replace(statsPattern, (match, indent) => {
    blocks += 1;
    return `${indent}cacheHits: 0,\n${indent}persistentArtworkHits: 0,\n${indent}persistentArtworkWrites: 0,\n${indent}providerRequests:`;
  });
  if (blocks !== 2) fail(`Persistent artwork diagnostics expected two blocks; found ${blocks}`);
  if (!source.includes('stats.persistentArtworkHits += 1;')) {
    source = replaceOnce(source, '    // Stage 1: scan every selected unique JAV code through the primary provider.\n', `    // Rehydrate disk-backed last-known-good artwork after the in-memory cache.\n    for (const item of normalized) {\n      const sourceId = String(item.sourceId);\n      if (resolvedById.has(sourceId)) continue;\n      const persisted = artworkStore.get(sourceId);\n      if (!persisted?.poster) continue;\n      const restored = Object.freeze({\n        ...item,\n        poster: persisted.poster,\n        background: persisted.background || persisted.poster,\n        metadataProvider: persisted.metadataProvider || item.metadataProvider,\n        lookupQuery: persisted.lookupQuery || item.lookupQuery,\n        sceneCode: item.sceneCode || persisted.sceneCode,\n        releaseDate: item.releaseDate || persisted.releaseDate,\n        studio: item.studio || persisted.studio,\n        performers: Array.isArray(item.performers) && item.performers.length ? item.performers : persisted.performers,\n        tags: Array.isArray(item.tags) && item.tags.length ? item.tags : persisted.tags,\n        contentTags: Array.isArray(item.contentTags) && item.contentTags.length ? item.contentTags : persisted.contentTags,\n        lookupSource: 'sukebei-persistent-cache',\n        contentClassificationKnown: Boolean(item.tags?.length || persisted.tags?.length),\n      });\n      stats.persistentArtworkHits += 1;\n      cache.set(\`sukebei:\${sourceId}\`, restored, positiveTtlMs);\n      resolvedById.set(sourceId, restored);\n    }\n    // Stage 1: scan every selected unique JAV code through the primary provider.\n`, 'Sukebei persistent rehydration');
  }
  if (!source.includes('artworkStore.setMany(allowed)')) {
    source = replaceOnce(source, '    // A transient metadata/poster outage must not erase valid RSS torrent\n', '    stats.persistentArtworkWrites += artworkStore.setMany(allowed);\n    // A transient metadata/poster outage must not erase valid RSS torrent\n', 'Sukebei persistent writes');
  }
  source = source.replace('      return Object.freeze({ sukebeiMetadata: lastDiagnostics });\n', '      return Object.freeze({ sukebeiMetadata: lastDiagnostics, sukebeiArtworkStore: artworkStore.diagnostics() });\n');
  if (!source.includes("catalog?.mode === 'rss'") || !source.includes("lookupSource: 'sukebei-persistent-cache'")) fail('Sukebei split/cache integration is incomplete');
  write('provider/tpb4k/sukebei-metadata.js', source);
  let gitignore = fs.existsSync(path.join(root, '.gitignore')) ? read('.gitignore') : '';
  if (!gitignore.split(/\r?\n/).includes('.onlyporn-cache/')) gitignore += `${gitignore.endsWith('\n') || !gitignore ? '' : '\n'}.onlyporn-cache/\n`;
  write('.gitignore', gitignore);
}
function patchServerSdk() {
  let source = read('server-sdk/index.js');
  if (!source.includes('opts.configureApp(app)')) source = replaceOnce(source, "    app.set('trust proxy', true);\n", "    app.set('trust proxy', true);\n    if (typeof opts.configureApp === 'function') opts.configureApp(app);\n", 'server app configurator');
  write('server-sdk/index.js', source);
}
function patchServer() {
  let source = read('server.js');
  if (!source.includes('installSukebeiPosterRoute')) {
    source = replaceOnce(source, "const addonInterface = require('./addon');\n", "const addonInterface = require('./addon');\nconst { installSukebeiPosterRoute } = require('./provider/tpb4k/sukebei-rss-poster');\n", 'Sukebei route import');
    source = replaceOnce(source, 'serveHTTP(addonInterface, { port: process.env.PORT || 49581 });', "serveHTTP(addonInterface, { port: process.env.PORT || 49581, configureApp: installSukebeiPosterRoute });", 'Sukebei route install');
  }
  write('server.js', source);
}
function patchRetainedNamespaceAssertions() {
  const providerDir = path.join(root, 'provider');
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', '.git', '.python-venv', '__pycache__'].includes(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.test.js')) {
        const original = fs.readFileSync(target, 'utf8');
        const updated = original.replaceAll('.extra.tpb4k', '.extra.onlyporn').replaceAll('extra: { tpb4k:', 'extra: { onlyporn:').replaceAll('extra: {\n      tpb4k:', 'extra: {\n      onlyporn:');
        if (updated !== original) fs.writeFileSync(target, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');
      }
    }
  }
  walk(providerDir);
}
function patchRetainedCatalogContracts() {
  const contracts = {
    'provider/tpb4k-phase1.test.js': [
      ['Phase 1 defines the exact 28 selected TPB4K board catalogs', 'Phase 1 defines the exact 29 selected OnlyPorn board catalogs'],
      ['assert.equal(catalogDefinitions.length, 28);', 'assert.equal(catalogDefinitions.length, 29);'],
      ['assert.equal(tpb4kCatalogs.length, 28);', 'assert.equal(tpb4kCatalogs.length, 29);'],
      ['assert.equal(new Set(catalogDefinitions.map(item => item.id)).size, 28);', 'assert.equal(new Set(catalogDefinitions.map(item => item.id)).size, 29);'],
      ['TPB4K stays disabled by default and exposes its 28 descriptors only behind the feature flag', 'OnlyPorn board catalogs stay disabled by default and expose 29 descriptors only behind the feature flag'],
      ["assert.equal(tpb4kCatalogs.filter(item => item.id.startsWith('tpb4k.')).length, 28);", "assert.equal(tpb4kCatalogs.filter(item => item.id.startsWith('tpb4k.')).length, 29);"],
    ],
    'provider/tpb4k-phase2a.test.js': [
      ['Phase 2A release wiring preserves 28 catalogs, 37 feature catalogs, and prior hardening', 'Phase 2A release wiring preserves 29 catalogs, 38 feature catalogs, and prior hardening'],
      ['assert.equal(catalogDefinitions.length, 28);', 'assert.equal(catalogDefinitions.length, 29);'],
      ['assert.equal(9 + catalogDefinitions.length, 37);', 'assert.equal(9 + catalogDefinitions.length, 38);'],
    ],
    'provider/tpb4k-phase2b.test.js': [
      ['all 28 TPB4K catalog IDs remain unique and unified-resolution', 'all 29 OnlyPorn catalog IDs remain unique and unified-resolution'],
      ['assert.equal(tpb4kCatalogs.length, 28);', 'assert.equal(tpb4kCatalogs.length, 29);'],
      ['assert.equal(new Set(tpb4kCatalogs.map(item => item.id)).size, 28);', 'assert.equal(new Set(tpb4kCatalogs.map(item => item.id)).size, 29);'],
    ],
  };
  for (const [relative, replacements] of Object.entries(contracts)) {
    let source = read(relative);
    for (const [before, after] of replacements) source = replaceOnce(source, before, after, `${relative}: ${before}`);
    write(relative, source);
  }
  let manifestTest = read('provider/tpb4k-manifest-size.test.js');
  manifestTest = replaceOnce(manifestTest, 'result.catalogs !== 37', 'result.catalogs !== 38', 'manifest total contract');
  manifestTest = replaceOnce(manifestTest, 'result.tpb4kCatalogs !== 28', 'result.tpb4kCatalogs !== 29', 'manifest internal contract');
  write('provider/tpb4k-manifest-size.test.js', manifestTest);
}
function patchPackage() {
  const pkg = JSON.parse(read('package.json'));
  pkg.version = TARGET_VERSION;
  pkg.scripts ||= {};
  delete pkg.scripts['smoke:tpb4k-alpha17'];
  delete pkg.scripts['smoke:tpb4k-alpha18'];
  delete pkg.scripts['smoke:alpha19'];
  pkg.scripts['test:alpha20'] = 'node --test provider/onlyporn-alpha20-final.test.js provider/tpb4k-alpha19.test.js provider/tpb4k-alpha18-regression.test.js provider/tpb4k-hentaimama-series.test.js provider/tpb4k-all-19-playable-binding.test.js';
  pkg.scripts['audit:zero-comparison-dependency'] = 'node tools/audit-zero-comparison-dependency.js .';
  pkg.scripts['smoke:alpha20'] = 'node scripts/onlyporn-alpha20-acceptance.js';
  for (const testFile of ['provider/tpb4k-alpha19.test.js', 'provider/tpb4k-alpha18-regression.test.js', 'provider/tpb4k-hentaimama-series.test.js', 'provider/tpb4k-all-19-playable-binding.test.js', 'provider/onlyporn-alpha20-final.test.js']) {
    if (!String(pkg.scripts['test:release'] || '').includes(testFile)) pkg.scripts['test:release'] = `${pkg.scripts['test:release'] || 'node --test'} ${testFile}`;
  }
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  if (fs.existsSync(path.join(root, 'package-lock.json'))) {
    const lock = JSON.parse(read('package-lock.json'));
    lock.version = TARGET_VERSION;
    if (lock.packages?.['']) lock.packages[''].version = TARGET_VERSION;
    write('package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
  }
  for (const file of listTestFiles(root)) {
    const original = fs.readFileSync(file, 'utf8');
    const updated = original
      .replaceAll(`'${BASE_VERSION}'`, `'${TARGET_VERSION}'`)
      .replaceAll(`"${BASE_VERSION}"`, `"${TARGET_VERSION}"`)
      .replaceAll(`'2.7.0-alpha.19'`, `'${TARGET_VERSION}'`)
      .replaceAll(`"2.7.0-alpha.19"`, `"${TARGET_VERSION}"`);
    if (updated !== original) fs.writeFileSync(file, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');
  }
  auditReleaseVersionAssertions(root, TARGET_VERSION);
}
function validateInstallation() {
  const required = [
    'addon.js', 'catalog/tpb4k.js', 'provider/tpb4k.js', 'provider/tpb4k/candidate.js',
    'provider/tpb4k/hentaimama-series.js', 'provider/tpb4k/id-codec.js', 'provider/tpb4k/knaben.js',
    'provider/tpb4k/studio-metadata.js', 'provider/tpb4k/studio-playback-binding.js', 'provider/tpb4k/studio-targeted-recovery.js',
    'provider/tpb4k/sukebei-metadata.js', 'provider/tpb4k/sukebei-rss-poster.js', 'provider/tpb4k/sukebei-artwork-store.js',
    'provider/tpb4k/torrent-index.js', 'server-sdk/index.js', 'server.js', 'scripts/onlyporn-alpha20-acceptance.js',
    'provider/onlyporn-alpha20-final.test.js',
  ];
  for (const relative of required) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) fail(`Alpha.20 installation is missing ${relative}`);
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status !== 0) fail(`${relative} syntax check failed: ${check.stderr || check.stdout}`);
  }
  const pkg = JSON.parse(read('package.json'));
  if (pkg.version !== TARGET_VERSION) fail(`Installed package version is ${pkg.version}`);
  if (read('A20_FINGERPRINT.txt').trim() !== TARGET_FINGERPRINT) fail('Alpha.20 fingerprint mismatch');
  const addon = read('addon.js');
  if (!addon.includes("idPrefixes: ['onlyporn:', 'ophmm-']") || /(['"`])hmm-/i.test(addon)) fail('OnlyPorn resource ownership is invalid');
  const catalog = read('catalog/tpb4k.js');
  if (!catalog.includes("id: 'tpb4k.sukebei.rss'")) fail('Separated Sukebei RSS catalog is missing');
  if (!read('provider/tpb4k.js').includes('Array.isArray(decoded.torrents)')) fail('Multi-candidate stream return path is missing');
  if (!read('provider/tpb4k/id-codec.js').includes('const BUNDLE_VERSION = 3;')) fail('Version-3 candidate codec is missing');
  if (!read('provider/tpb4k/torrent-index.js').includes("source: 'knaben-targeted'")) fail('Targeted Knaben search is missing');
  if (!read('provider/tpb4k/studio-targeted-recovery.js').includes('for (let offset = 0;')) fail('Batched targeted recovery is missing');
  if (!read('provider/tpb4k/studio-metadata.js').includes('platformIdentityFields')) fail('OnlyFans identity propagation is missing');
  if (!read('provider/tpb4k/sukebei-metadata.js').includes("lookupSource: 'sukebei-persistent-cache'")) fail('Sukebei persistent cache integration is missing');
  if (!read('scripts/onlyporn-alpha20-acceptance.js').includes("Sukebei Top is empty")) fail('Live Sukebei Top gate is missing');
  auditReleaseVersionAssertions(root, TARGET_VERSION);
  auditZeroDependency(root);
}

verifyBase();
removeObsoleteComparisonCoupling();
installFullReplacements();
patchCatalog();
patchAddon();
patchCandidate();
patchTorrentIndex();
patchStudioMetadata();
patchSukebei();
patchServerSdk();
patchServer();
patchRetainedNamespaceAssertions();
patchRetainedCatalogContracts();
patchPackage();
validateInstallation();
console.log(`Applied OnlyPorn ${TARGET_VERSION}: immutable Alpha.20 handoff repair installed and validated.`);
