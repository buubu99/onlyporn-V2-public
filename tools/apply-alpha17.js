#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(process.argv[2] || process.cwd());
const alpha16 = path.join(root, 'tools/apply-all-19-playable-binding.js');

function fail(message) { throw new Error(message); }
function read(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) fail(`Required file is missing: ${relative}`);
  return fs.readFileSync(target, 'utf8');
}
function write(relative, value) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}
function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) fail(`Patch anchor not found: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) fail(`Patch anchor is ambiguous: ${label}`);
  return `${source.slice(0, index)}${after}${source.slice(index + before.length)}`;
}

if (!fs.existsSync(alpha16)) fail('Alpha.16 binding patcher is missing');
const result = spawnSync(process.execPath, [alpha16, root], { stdio: 'inherit' });
if (result.status !== 0) fail('All-19 studio binding patch failed');

function patchDiscoveryRegistry() {
  let source = read('provider/tpb4k/adapters/discovery.js');
  if (!source.includes("require('../hentaimama-series')")) {
    source = replaceOnce(
      source,
      "const { createNativeAdapter } = require('../native-discovery');\n",
      "const { createNativeAdapter } = require('../native-discovery');\nconst { createHentaiMamaSeriesAdapter } = require('../hentaimama-series');\n",
      'HentaiMama series adapter import'
    );
  }
  source = source.replace("    createNativeAdapter('hentai', common),\n", "    createHentaiMamaSeriesAdapter(common),\n");
  write('provider/tpb4k/adapters/discovery.js', source);
}

function patchCatalogs() {
  let source = read('catalog/tpb4k.js');
  for (const id of ['tpb4k.hentai.all', 'tpb4k.hentai.new', 'tpb4k.hentai.top']) {
    const idLine = `    id: '${id}',\n`;
    const start = source.indexOf(idLine);
    if (start < 0) fail(`Hentai catalogue is missing: ${id}`);
    const end = source.indexOf('  },', start);
    const block = source.slice(start, end);
    if (!block.includes("type: 'series'")) {
      source = `${source.slice(0, start + idLine.length)}    type: 'series',\n${source.slice(start + idLine.length)}`;
    }
  }
  source = source.replace("    type: 'movie',\n    name: definition.name,\n", "    type: definition.type || 'movie',\n    name: definition.name,\n");
  write('catalog/tpb4k.js', source);
}

function patchAddon() {
  let source = read('addon.js');
  source = source.replace("  types: ['movie'],\n", "  types: ['movie', 'series'],\n");
  write('addon.js', source);
}

function patchSourceContract() {
  let source = read('provider/tpb4k/source-contract.js');
  if (!source.includes('videos: Array.isArray(item.videos)')) {
    source = replaceOnce(
      source,
      "    duration: Number.parseInt(String(item.duration ?? 0), 10) || 0,\n",
      "    duration: Number.parseInt(String(item.duration ?? 0), 10) || 0,\n    episode: Number.parseInt(String(item.episode ?? 0), 10) || 0,\n    seriesSlug: String(item.seriesSlug || '').trim(),\n    videos: Array.isArray(item.videos) ? item.videos.map(video => Object.freeze({ ...video })) : [],\n",
      'source contract Hentai episode fields'
    );
  }
  write('provider/tpb4k/source-contract.js', source);
}

function patchProvider() {
  let source = read('provider/tpb4k.js');
  source = source.replace("const TYPE = 'movie';\n", "const MOVIE_TYPE = 'movie';\nconst SERIES_TYPE = 'series';\nconst HENTAI_PREFIX = 'hmm-';\n");
  if (!source.includes('function catalogType(catalogId)')) {
    source = replaceOnce(
      source,
      "function toLinks(identity) {\n",
      `function catalogType(catalogId) {
  return String(catalogId || '').startsWith('tpb4k.hentai.') ? SERIES_TYPE : MOVIE_TYPE;
}
function isHentaiResourceId(id) {
  return String(id || '').startsWith(HENTAI_PREFIX);
}
function requestIdentity(args = {}) {
  if (args.type === SERIES_TYPE && isHentaiResourceId(args.id)) {
    return Object.freeze({ source: 'hentai', sourceId: String(args.id), catalogId: 'tpb4k.hentai.all' });
  }
  return decodeTpb4kId(args.id);
}
function toLinks(identity) {
`,
      'provider dynamic type helpers'
    );
  }
  source = source.replace('function toMetaPreview(item, catalogId, config) {\n', 'function toMetaPreview(item, catalogId, config) {\n  const type = catalogType(catalogId);\n');
  source = source.replace(
    "  const id = encodeTpb4kId({\n    source: item.source,\n",
    "  const id = type === SERIES_TYPE && isHentaiResourceId(item.sourceId)\n    ? item.sourceId\n    : encodeTpb4kId({\n    source: item.source,\n"
  );
  source = source.replace("    type: TYPE,\n    name: item.title,\n", "    type,\n    name: item.title,\n");
  source = source.replace('function toMetaResponse(item, id, config) {\n', 'function toMetaResponse(item, id, config, type = MOVIE_TYPE) {\n');
  source = source.replace("    type: TYPE,\n    name: item.title,\n", "    type,\n    name: item.title,\n");
  if (!source.includes('...(type === SERIES_TYPE && Array.isArray(item.videos)')) {
    source = replaceOnce(
      source,
      "    links: toLinks(identity),\n    extra: {\n",
      "    links: toLinks(identity),\n    ...(type === SERIES_TYPE && Array.isArray(item.videos) ? { videos: item.videos } : {}),\n    extra: {\n",
      'provider Hentai videos metadata'
    );
  }
  source = source.replace(
    "  activate(id) {\n    const value = String(id || '');\n    return value.startsWith('tpb4k.') || value.startsWith('onlyporn:tpb4k:');\n",
    "  activate(id) {\n    const value = String(id || '');\n    return value.startsWith('tpb4k.') || value.startsWith('onlyporn:tpb4k:') || value.startsWith(HENTAI_PREFIX);\n"
  );
  source = source.replace(
    "  async handleCatalog(args) {\n    if (args.type !== TYPE || !this.enabled()) return { metas: [] };\n    const definition = getCatalogDefinition(args.id);\n    if (!definition) return { metas: [] };\n",
    "  async handleCatalog(args) {\n    if (!this.enabled()) return { metas: [] };\n    const definition = getCatalogDefinition(args.id);\n    if (!definition || args.type !== (definition.type || MOVIE_TYPE)) return { metas: [] };\n"
  );
  source = source.replace(
    "  async handleMeta(args) {\n    if (args.type !== TYPE || !this.enabled()) return { meta: {} };\n    const decoded = decodeTpb4kId(args.id);\n    if (!decoded) return { meta: {} };\n",
    "  async handleMeta(args) {\n    if (!this.enabled()) return { meta: {} };\n    const decoded = requestIdentity(args);\n    if (!decoded || args.type !== catalogType(decoded.catalogId)) return { meta: {} };\n"
  );
  source = source.replace(
    "    const item = normalizeDiscoveryItem(adapter, rawItem);\n    if (!item) return { meta: {} };\n    const evaluation = evaluateContent(item, this.contentFilter);\n",
    "    const normalized = normalizeDiscoveryItem(adapter, rawItem);\n    const item = normalized && Array.isArray(rawItem?.videos)\n      ? Object.freeze({ ...normalized, videos: rawItem.videos })\n      : normalized;\n    if (!item) return { meta: {} };\n    const evaluation = evaluateContent(item, this.contentFilter);\n"
  );
  source = source.replace(
    "    return { meta: toMetaResponse(item, args.id, config) };\n",
    "    return { meta: toMetaResponse(item, args.id, config, catalogType(decoded.catalogId)) };\n"
  );
  source = source.replace(
    "  async handleStream(args) {\n    if (args.type !== TYPE || !this.enabled()) return { streams: [] };\n    const decoded = decodeTpb4kId(args.id);\n    if (!decoded) return { streams: [] };\n",
    "  async handleStream(args) {\n    if (!this.enabled()) return { streams: [] };\n    const decoded = requestIdentity(args);\n    if (!decoded || args.type !== catalogType(decoded.catalogId)) return { streams: [] };\n"
  );
  if (!source.includes('const hentaiEpisodeNumber =')) {
    source = replaceOnce(
      source,
      "    const streams = sortCandidates(dedupeCandidates(normalized))\n      .map(toStremioStream)\n      .filter(Boolean);\n",
      [
        "    const hentaiEpisodeNumber = decoded.source === 'hentai'",
        "      ? Number(String(decoded.sourceId).match(/:1:(\\d+)$/)?.[1] || 0)",
        "      : 0;",
        "    const streams = sortCandidates(dedupeCandidates(normalized))",
        "      .map(candidate => {",
        "        const stream = toStremioStream(candidate);",
        "        if (!stream || decoded.source !== 'hentai' || !stream.url) return stream;",
        "        const label = `HentaiMama E${hentaiEpisodeNumber || candidate.episode || 1}`;",
        "        return {",
        "          ...stream,",
        "          name: label,",
        "          title: label,",
        "          description: label,",
        "          behaviorHints: {",
        "            ...(stream.behaviorHints || {}),",
        "            bingeGroup: `hentaimama:${String(decoded.sourceId).split(':')[0]}`,",
        "          },",
        "        };",
        "      })",
        "      .filter(Boolean);",
        "",
      ].join('\n'),
      'provider HentaiMama passthrough labels'
    );
  }
  write('provider/tpb4k.js', source);
}

function patchRetainedTests() {
  const relative = 'provider/tpb4k-phase2c.test.js';
  let source = read(relative);
  source = source.replace(
    "    const catalog = await provider.handleCatalog({ type: 'movie', id, extra: { skip: 0 } });\n    assert.equal(catalog.metas.length, 2, id);\n    const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });\n    assert.equal(meta.meta.name, 'Detailed Scene', id);\n    assert.deepEqual(await provider.handleStream({ type: 'movie', id: catalog.metas[0].id }), { streams: [] }, id);\n",
    "    const type = id.startsWith('tpb4k.hentai.') ? 'series' : 'movie';\n    const catalog = await provider.handleCatalog({ type, id, extra: { skip: 0 } });\n    assert.equal(catalog.metas.length, 2, id);\n    const meta = await provider.handleMeta({ type, id: catalog.metas[0].id });\n    assert.equal(meta.meta.name, 'Detailed Scene', id);\n    assert.deepEqual(await provider.handleStream({ type, id: catalog.metas[0].id }), { streams: [] }, id);\n"
  );
  const startName = "test('HentaiMama resolves a series to its latest episode and validates the direct MP4'";
  const nextName = "test('live-shaped selectors accept only exact YesPorn and HentaiMama content paths'";
  const start = source.indexOf(startName);
  const end = source.indexOf(nextName, start + 1);
  if (start >= 0 && end > start) {
    const replacement = `test('HentaiMama exact series and episode behavior is covered by the alpha.17 regression suite', () => {\n  const pkg = require('../package.json');\n  assert.match(pkg.scripts['test:release'], /tpb4k-hentaimama-series\\.test\\.js/);\n});\n`;
    source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  }
  if (!source.includes("const type = id.startsWith('tpb4k.hentai.') ? 'series' : 'movie';")) {
    fail('Retained Phase 2C provider test was not converted to dynamic movie/series routing');
  }
  if (source.includes("provider.handleCatalog({ type: 'movie', id, extra: { skip: 0 } });")) {
    fail('Retained Phase 2C provider test still contains the obsolete movie-only Hentai request');
  }
  write(relative, source);
}

function patchVersionReferences() {
  const allowed = new Set(['.js', '.json', '.md']);
  const excluded = new Set(['.git', 'node_modules', '.python-venv']);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(target); continue; }
      if (!allowed.has(path.extname(entry.name))) continue;
      const original = fs.readFileSync(target, 'utf8');
      const updated = original.replace(/2\.7\.0-alpha\.16/g, '2.7.0-alpha.17');
      if (updated !== original) fs.writeFileSync(target, updated, 'utf8');
    }
  }
  visit(root);
}

function patchPackage() {
  const value = JSON.parse(read('package.json'));
  value.version = '2.7.0-alpha.17';
  value.scripts ||= {};
  value.scripts['test:tpb4k-hentaimama-series'] = 'node --test provider/tpb4k-hentaimama-series.test.js';
  value.scripts['test:tpb4k-alpha17'] = 'node --test provider/tpb4k-all-19-playable-binding.test.js provider/tpb4k-hentaimama-series.test.js';
  value.scripts['smoke:tpb4k-alpha17'] = 'node scripts/tpb4k-alpha17-acceptance.js';
  if (!String(value.scripts['test:release'] || '').includes('provider/tpb4k-hentaimama-series.test.js')) {
    value.scripts['test:release'] = `${value.scripts['test:release']} provider/tpb4k-hentaimama-series.test.js`;
  }
  write('package.json', `${JSON.stringify(value, null, 2)}\n`);
  const lock = path.join(root, 'package-lock.json');
  if (fs.existsSync(lock)) {
    const parsed = JSON.parse(fs.readFileSync(lock, 'utf8'));
    parsed.version = '2.7.0-alpha.17';
    if (parsed.packages?.['']) parsed.packages[''].version = '2.7.0-alpha.17';
    write('package-lock.json', `${JSON.stringify(parsed, null, 2)}\n`);
  }
}

function patchReadme() {
  const target = path.join(root, 'README.md');
  if (!fs.existsSync(target)) return;
  let source = fs.readFileSync(target, 'utf8').replace(/2\.7\.0-alpha\.16/g, '2.7.0-alpha.17');
  if (!source.includes('HentaiMama series and exact-episode parity')) {
    source += '\n## TPB4K alpha.17\n\nAlpha.17 keeps the 19 studio catalogues on metadata-first, catalogue-bound torrent identities and treats HentaiMama independently as a Stremio series source. Hentai cards use `hmm-` IDs, metadata includes every discovered episode, and stream resolution targets the exact selected episode while retaining every validated direct player URL.\n';
  }
  fs.writeFileSync(target, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
}

patchDiscoveryRegistry();
patchCatalogs();
patchAddon();
patchProvider();
patchRetainedTests();
patchPackage();
patchReadme();
patchVersionReferences();

for (const relative of [
  'provider/tpb4k.js',
  'provider/tpb4k/hentaimama-series.js',
  'provider/tpb4k/adapters/discovery.js',
  'catalog/tpb4k.js',
  'addon.js',
]) {
  const check = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
  if (check.status !== 0) fail(`${relative} failed syntax validation: ${check.stderr || check.stdout}`);
}
console.log('Applied 2.7.0-alpha.17: all-19 bound studio playback plus independent HentaiMama series/episode parity.');
