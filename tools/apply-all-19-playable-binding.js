#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || process.cwd());

function fail(message) {
  throw new Error(message);
}

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
  const first = source.indexOf(before);
  if (first < 0) fail(`Patch anchor not found: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) fail(`Patch anchor is ambiguous: ${label}`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function patchProvider() {
  let source = read('provider/tpb4k.js');
  if (!source.includes("require('./tpb4k/studio-playback-binding')")) {
    source = replaceOnce(
      source,
      "const { fallbackPosterUrl } = require('./tpb4k/poster-enrichment');\n",
      "const { fallbackPosterUrl } = require('./tpb4k/poster-enrichment');\nconst { bindStudioPlayback } = require('./tpb4k/studio-playback-binding');\n",
      'provider binder import'
    );
  }

  if (!source.includes('...(item.infoHash ? {')) {
    source = replaceOnce(
      source,
      `    catalogId,
  });
`,
      `    catalogId,
    ...(item.infoHash ? {
      torrent: {
        infoHash: item.infoHash,
        title: item.title,
        filename: item.filename || item.title,
        resolution: item.resolution,
        indexer: item.indexer || 'torrent-index',
        seeders: item.seeders,
        size: item.size,
        fileIdx: item.fileIdx,
      },
    } : {}),
  });
`,
      'provider version-2 preview encoding'
    );
  }

  if (!source.includes('const requiresPlayableBinding =')) {
    const startMarker = '    let rawItems = [];\n    try {\n';
    const start = source.indexOf(startMarker);
    if (start < 0) fail('Provider catalog try-block start was not found');
    const catchMarker = '    } catch (error) {\n';
    const end = source.indexOf(catchMarker, start + startMarker.length);
    if (end < 0) fail('Provider catalog try-block end was not found');
    const replacement = `    let rawItems = [];
    let studioPlaybackBinding;
    try {
      const requestedLimit = this.contentFilter.enabled
        ? Math.min(config.catalogLimit * config.contentFilterOverscanFactor, 100)
        : config.catalogLimit;
      const requiresPlayableBinding = (
        ['studio-metadata', 'platform-hybrid'].includes(definition.source) &&
        definition.lookupSource === 'torrent-index'
      );
      if (requiresPlayableBinding) {
        const resolverAdapter = getAdapter(definition.lookupSource);
        if (!resolverAdapter) throw new Error('TPB4K studio torrent resolver is unavailable');
        const metadataPoolLimit = 300;
        const torrentPoolLimit = 100;
        const loadTorrentPool = typeof resolverAdapter.catalogTorrents === 'function'
          ? resolverAdapter.catalogTorrents.bind(resolverAdapter)
          : resolverAdapter.catalog.bind(resolverAdapter);
        const [metadataItems, torrentItems] = await Promise.all([
          adapter.catalog({
            catalog: { ...definition, playbackBindingPool: true },
            skip: 0,
            limit: metadataPoolLimit,
            config,
          }),
          loadTorrentPool({
            catalog: { ...definition, source: 'torrent-index', playbackBindingPool: true },
            skip: 0,
            limit: torrentPoolLimit,
            config,
          }),
        ]);
        const binding = bindStudioPlayback({
          catalog: definition,
          metadataItems,
          torrentItems,
          skip,
          limit: config.catalogLimit,
        });
        rawItems = [...binding.items];
        studioPlaybackBinding = binding.stats;
      } else {
        rawItems = await adapter.catalog({
          catalog: definition,
          skip,
          limit: ['studio-metadata', 'platform-hybrid', 'torrent-index'].includes(definition.source)
            ? config.catalogLimit
            : requestedLimit,
          config,
        });
      }
`;
    source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  }

  if (!source.includes('let rawCandidates = decoded.torrent')) {
    source = replaceOnce(
      source,
      `    let rawCandidates = [];
    try {
      rawCandidates = await adapter.resolve({
        sourceId: decoded.sourceId,
        catalogId: decoded.catalogId,
        config,
      });
    } catch {
      logger().warn(
        { provider: this.name, source: decoded.source },
        'TPB4K stream adapter failed safely'
      );
    }
`,
      `    const definition = getCatalogDefinition(decoded.catalogId);
    const resolverAdapter = getAdapter(definition?.lookupSource || decoded.source);
    if (!resolverAdapter) return { streams: [] };
    let rawCandidates = decoded.torrent
      ? [{
        ...decoded.torrent,
        source: decoded.torrent.indexer || 'torrent-index',
        sourceId: decoded.sourceId,
        provenance: ['catalog-bound-torrent'],
      }]
      : [];
    if (!decoded.torrent) {
      try {
        rawCandidates = await resolverAdapter.resolve({
          sourceId: decoded.sourceId,
          catalogId: decoded.catalogId,
          catalog: definition,
          item: rawItem,
          config,
        });
      } catch {
        logger().warn(
          { provider: this.name, source: decoded.source, resolver: resolverAdapter.id },
          'TPB4K stream adapter failed safely'
        );
      }
    }
`,
      'provider bound-torrent stream path'
    );
    source = source.replace(
      '        ...candidate,\n        source: decoded.source,\n',
      "        ...candidate,\n        source: candidate?.source || resolverAdapter.id || decoded.source,\n"
    );
  }

  if (!source.includes('...(studioPlaybackBinding ? { studioPlaybackBinding } : {}),')) {
    source = replaceOnce(
      source,
      '        ...(platformHybrid ? { platformHybrid } : {}),\n',
      '        ...(platformHybrid ? { platformHybrid } : {}),\n        ...(studioPlaybackBinding ? { studioPlaybackBinding } : {}),\n',
      'provider binding diagnostics'
    );
  }
  write('provider/tpb4k.js', source);
}

function patchKnaben() {
  let source = read('provider/tpb4k/knaben.js');
  if (!source.includes("const orderBy = searchOptions.orderBy === 'date' ? 'date' : 'seeders';")) {
    source = replaceOnce(
      source,
      '  async function fetchStudio(studio) {\n    const query = compactText(studio).slice(0, 180);\n',
      "  async function fetchStudio(studio, searchOptions = {}) {\n    const query = compactText(studio).slice(0, 180);\n    const orderBy = searchOptions.orderBy === 'date' ? 'date' : 'seeders';\n",
      'Knaben ordered studio search'
    );
    source = replaceOnce(
      source,
      '    const cacheKey = `knaben:studio:${compactComparable(query)}`;\n',
      '    const cacheKey = `knaben:studio:${compactComparable(query)}:${orderBy}`;\n',
      'Knaben ordered cache key'
    );
    source = replaceOnce(
      source,
      "            order_by: 'seeders',\n",
      '            order_by: orderBy,\n',
      'Knaben ordered request body'
    );
    source = replaceOnce(
      source,
      `    async searchStudio(studio) {
      if (options.enabled === false) return [];
      return fetchStudio(studio);
    },
`,
      `    async searchStudio(studio, searchOptions = {}) {
      if (options.enabled === false) return [];
      return fetchStudio(studio, searchOptions);
    },
`,
      'Knaben ordered public method'
    );
  }
  write('provider/tpb4k/knaben.js', source);
}

function patchTorrentIndex() {
  let source = read('provider/tpb4k/torrent-index.js');
  if (!source.includes('async function loadWindow(catalog, skip, limit, options = {})')) {
    source = replaceOnce(
      source,
      '  async function loadWindow(catalog, skip, limit) {\n',
      '  async function loadWindow(catalog, skip, limit, options = {}) {\n',
      'torrent loadWindow options'
    );
  }

  if (!source.includes("catalog?.playbackBindingPool ? ['seeders', 'date'] : ['seeders']")) {
    source = replaceOnce(
      source,
      `    try {
      const records = await knabenClient.searchStudio(catalog.studio);
      diagnostics.push({
        source: 'knaben',
        outcome: 'accepted',
        records: records.length,
      });
      for (const record of records.slice(normalizedSkip)) {
        const infoHash = extractInfoHash(record.infoHash || record.magnetLink);
        if (!infoHash || Number(record.seeders || 0) < minimumSeeders || seen.has(infoHash)) continue;
        seen.add(infoHash);
        privateIndex.remember(record, catalog);
        output.push(publicTorrentItem(record, catalog));
        if (output.length >= normalizedLimit) break;
      }
    } catch (error) {
      diagnostics.push({
        source: 'knaben',
        outcome: 'error',
        error: compactText(error?.message || error),
      });
    }
`,
      `    const knabenOrders = catalog?.playbackBindingPool ? ['seeders', 'date'] : ['seeders'];
    const knabenResults = await Promise.allSettled(
      knabenOrders.map(orderBy => knabenClient.searchStudio(catalog.studio, { orderBy }))
    );
    for (let orderIndex = 0; orderIndex < knabenResults.length; orderIndex += 1) {
      const orderBy = knabenOrders[orderIndex];
      const result = knabenResults[orderIndex];
      if (result.status === 'rejected') {
        diagnostics.push({
          source: 'knaben',
          orderBy,
          outcome: 'error',
          error: compactText(result.reason?.message || result.reason),
        });
        continue;
      }
      diagnostics.push({
        source: 'knaben',
        orderBy,
        outcome: 'accepted',
        records: result.value.length,
      });
      for (const record of result.value.slice(normalizedSkip)) {
        const infoHash = extractInfoHash(record.infoHash || record.magnetLink);
        if (!infoHash || Number(record.seeders || 0) < minimumSeeders || seen.has(infoHash)) continue;
        seen.add(infoHash);
        privateIndex.remember(record, catalog);
        output.push(publicTorrentItem(record, catalog));
        if (output.length >= normalizedLimit) break;
      }
      if (output.length >= normalizedLimit) break;
    }
`,
      'torrent dual Knaben identity windows'
    );
  }

  if (!source.includes("mode: 'identity-only'")) {
    source = replaceOnce(
      source,
      '    const enrichment = await posterEnricher.enrichItems(selected);\n',
      `    const enrichment = options.enrichPosters !== false
      ? await posterEnricher.enrichItems(selected)
      : Object.freeze({
        items: Object.freeze(selected),
        stats: Object.freeze({ mode: 'identity-only', skipped: selected.length }),
      });
`,
      'torrent identity-only pool'
    );
  }

  if (!source.includes('async catalogTorrents({ catalog, skip, limit })')) {
    source = replaceOnce(
      source,
      `    async catalog({ catalog, skip, limit }) {
      if (!compactText(catalog?.studio)) return [];
      return loadWindow(catalog, skip, limit);
    },
`,
      `    async catalog({ catalog, skip, limit }) {
      if (!compactText(catalog?.studio)) return [];
      return loadWindow(catalog, skip, limit);
    },
    async catalogTorrents({ catalog, skip, limit }) {
      if (!compactText(catalog?.studio)) return [];
      return loadWindow(catalog, skip, limit, { enrichPosters: false });
    },
`,
      'torrent catalogTorrents method'
    );
  }
  write('provider/tpb4k/torrent-index.js', source);
}

function patchStudioMetadata() {
  let source = read('provider/tpb4k/studio-metadata.js');
  if (!source.includes('const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;')) {
    source = replaceOnce(
      source,
      "    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);\n",
      "    const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;\n    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), maximumLimit);\n",
      'studio metadata binding-pool limit'
    );
  }
  write('provider/tpb4k/studio-metadata.js', source);
}

function patchPlatformHybrid() {
  let source = read('provider/tpb4k/platform-hybrid.js');
  if (!source.includes('const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;')) {
    source = replaceOnce(
      source,
      "    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);\n",
      "    const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;\n    const safeLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), maximumLimit);\n",
      'platform hybrid binding-pool limit'
    );
  }
  if (!source.includes('if (catalog?.playbackBindingPool) {')) {
    source = replaceOnce(
      source,
      "    const output = [...metadata];\n    let torrent = [];\n",
      `    const output = [...metadata];
    let torrent = [];
    if (catalog?.playbackBindingPool) {
      lastDiagnostics = Object.freeze({
        platformHybrid: Object.freeze({
          metadataRecords: metadata.length,
          torrentFallbackRecords: 0,
          returned: metadata.length,
          playbackBindingPool: true,
        }),
        ...(metadataAdapter.diagnostics?.() || {}),
      });
      return output;
    }
`,
      'platform hybrid metadata-only binding pool'
    );
  }
  write('provider/tpb4k/platform-hybrid.js', source);
}

function patchSourceContract() {
  let source = read('provider/tpb4k/source-contract.js');
  if (!source.includes("const infoHash = String(item.infoHash || '').trim().toLowerCase();")) {
    source = replaceOnce(
      source,
      "  if (!sourceId || !title) return null;\n\n  return Object.freeze({\n",
      "  if (!sourceId || !title) return null;\n  const infoHash = String(item.infoHash || '').trim().toLowerCase();\n\n  return Object.freeze({\n",
      'source contract infoHash normalization'
    );
  }
  if (!source.includes("infoHash: /^[a-f0-9]{40}$/.test(infoHash) ? infoHash : '',")) {
    source = replaceOnce(
      source,
      "    size: item.size ?? 0,\n",
      "    size: item.size ?? 0,\n    infoHash: /^[a-f0-9]{40}$/.test(infoHash) ? infoHash : '',\n    filename: String(item.filename || item.title || item.name || '').replace(/\\s+/g, ' ').trim(),\n    indexer: String(item.indexer || '').replace(/\\s+/g, ' ').trim().toLowerCase(),\n    fileIdx: Number.isInteger(item.fileIdx) && item.fileIdx >= 0 ? item.fileIdx : null,\n",
      'source contract bound torrent fields'
    );
  }
  write('provider/tpb4k/source-contract.js', source);
}

function replaceTestBlock(source, startName, nextName, replacement) {
  const start = source.indexOf(`test('${startName}'`);
  if (start < 0) fail(`Regression test was not found: ${startName}`);
  const end = nextName
    ? source.indexOf(`test('${nextName}'`, start + 1)
    : source.length;
  if (end < 0) fail(`Following regression test was not found: ${nextName}`);
  return `${source.slice(0, start)}${replacement.trim()}\n${source.slice(end)}`;
}

function patchRegressionTests() {
  let source = read('provider/tpb4k-torrent-index.test.js');
  if (
    !source.includes("catalog-time version-2 binding avoids a second title search") &&
    source.includes("test('metadata-first studio cards resolve through their configured torrent lookup adapter'")
  ) {
    source = replaceTestBlock(
      source,
      'metadata-first studio cards resolve through their configured torrent lookup adapter',
      '18 studio rows are metadata-first and OnlyFans uses a metadata-first/torrent hybrid with retained TPB provenance',
      `test('catalog-time version-2 binding avoids a second title search', async () => {
  let resolverCalls = 0;
  registerAdapter({
    id: 'studio-metadata',
    configured: true,
    async catalog() {
      return [{
        sourceId: 'tpdb:vixen-one',
        title: 'Scene One',
        studio: 'Vixen',
        releaseDate: '2026-07-29',
        poster: 'https://images.example/vixen-one.jpg',
        lookupSource: 'torrent-index',
      }];
    },
    async meta({ sourceId }) {
      return {
        sourceId,
        title: 'Scene One',
        studio: 'Vixen',
        releaseDate: '2026-07-29',
        poster: 'https://images.example/vixen-one.jpg',
        lookupSource: 'torrent-index',
      };
    },
    async resolve() {
      throw new Error('metadata adapter must not resolve studio torrents');
    },
  });
  const torrent = {
    sourceId: 'knaben:vixen-one',
    title: 'Vixen 2026 07 29 Scene One 2160p',
    studio: 'Vixen',
    filename: 'Vixen.Scene.One.2160p.mkv',
    infoHash: HASH_A,
    resolution: '4K',
    indexer: 'knaben',
    seeders: 14,
    size: '6.5 GiB',
  };
  registerAdapter({
    id: 'torrent-index',
    configured: true,
    async catalog() { return [torrent]; },
    async catalogTorrents() { return [torrent]; },
    async meta() { return null; },
    async resolve() {
      resolverCalls += 1;
      throw new Error('bound cards must not perform click-time searches');
    },
  });
  const provider = new Tpb4kProvider({
    env: env({ TPB4K_CATALOG_LIMIT: '1', TPB4K_MINIMUM_SEEDERS: '3' }),
    installBuiltIns: false,
  });
  const catalog = await provider.handleCatalog({
    type: 'movie',
    id: 'tpb4k.studio.vixen.top',
    extra: {},
  });
  assert.equal(catalog.metas.length, 1);
  const decoded = decodeTpb4kId(catalog.metas[0].id);
  assert.equal(decoded.version, 2);
  assert.equal(decoded.torrent.infoHash, HASH_A);
  const result = await provider.handleStream({ type: 'movie', id: catalog.metas[0].id });
  assert.equal(resolverCalls, 0);
  assert.equal(result.streams.length, 1);
  assert.equal(result.streams[0].infoHash, HASH_A);
  assert.equal(result.streams[0].title, 'Vixen.Scene.One.2160p.mkv');
  assert.equal(result.streams[0].behaviorHints.filename, 'Vixen.Scene.One.2160p.mkv');
  assert.equal(result.streams[0].behaviorHints.videoSize, 6.5 * 1024 ** 3);
  assert.match(result.streams[0].description, /👤 14/);
  assert.match(result.streams[0].description, /🔎 knaben/);
});`
    );
  }
  if (!source.includes("built-in provider exposes only playable metadata-first version-2 studio cards")) {
    source = replaceTestBlock(
      source,
      'built-in provider exposes metadata-first studio cards and retains the TPB adapter for Phase 3',
      '',
      `test('built-in provider exposes only playable metadata-first version-2 studio cards', async () => {
  const metadataScenes = [
    {
      id: 'vixen-1', title: 'Scene One', date: '2026-07-29', site: { name: 'Vixen' },
      tags: [{ name: 'Romantic' }],
      images: [{ url: 'https://images.example/vixen-1.jpg', width: 600, height: 900 }],
    },
    {
      id: 'vixen-2', title: 'Scene Two', date: '2026-07-28', site: { name: 'Vixen' },
      tags: [{ name: 'Outdoor' }],
      images: [{ url: 'https://images.example/vixen-2.jpg', width: 600, height: 900 }],
    },
  ];
  const fetchImpl = async (url, request = {}) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'api.theporndb.example') {
      const match = parsed.pathname.match(/\\/scenes\\/([^/]+)$/);
      const data = match
        ? metadataScenes.find(item => item.id === decodeURIComponent(match[1]))
        : metadataScenes;
      const body = JSON.stringify({ data });
      return {
        ok: true,
        status: 200,
        headers: { get: name => String(name).toLowerCase() === 'content-type' ? 'application/json' : String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : '' },
        async text() { return body; },
      };
    }
    if (parsed.hostname === 'thehiddenbay.com' && parsed.pathname.startsWith('/search/')) {
      return response(page([
        { title: 'Vixen 2026 07 29 Scene One 2160p', hash: HASH_A, seeders: 35 },
        { title: 'Vixen 2026 07 28 Scene Two 2160p', hash: HASH_B, seeders: 20 },
      ]));
    }
    if (parsed.hostname.includes('sukebei')) {
      return response('<?xml version="1.0"?><rss><channel></channel></rss>', 200, 'application/rss+xml');
    }
    return response('<html></html>');
  };
  const runtimeEnv = env({
    TPDB_API_KEY: 'fixture-key',
    TPDB_REST_API_URL: 'https://api.theporndb.example',
  });
  clearAdapters();
  installBuiltInAdapters({ env: runtimeEnv, fetchImpl, checkDns: false, minRequestIntervalMs: 0 });
  assert.equal(listAdapters().includes('torrent-index'), true);
  assert.equal(listAdapters().includes('studio-metadata'), true);
  const torrentAdapter = getAdapter('torrent-index');
  assert.equal(torrentAdapter.category, '507');
  assert.equal(torrentAdapter.sort, '7');
  const provider = new Tpb4kProvider({ env: runtimeEnv, fetchImpl, installBuiltIns: false });
  const catalog = await provider.handleCatalog({
    type: 'movie', id: 'tpb4k.studio.vixen.top', extra: { skip: 0 },
  });
  assert.equal(catalog.metas.length, 2);
  for (const item of catalog.metas) {
    assert.equal(item.posterShape, 'poster');
    assert.match(item.poster, /^https:\\/\\/images\\.example\\//);
    assert.doesNotMatch(item.poster, /assets\\/tpb4k\\/studios/);
    const decoded = decodeTpb4kId(item.id);
    assert.equal(decoded.version, 2);
    assert.equal(decoded.source, 'studio-metadata');
    assert.match(decoded.sourceId, /^tpdb:/);
    assert.match(decoded.torrent.infoHash, /^[a-f0-9]{40}$/);
    const stream = await provider.handleStream({ type: 'movie', id: item.id });
    assert.equal(stream.streams.length, 1);
    assert.equal(stream.streams[0].infoHash, decoded.torrent.infoHash);
  }
  const meta = await provider.handleMeta({ type: 'movie', id: catalog.metas[0].id });
  assert.match(meta.meta.poster, /^https:\\/\\/images\\.example\\//);
  assert.equal(meta.meta.posterShape, 'poster');
  assert.equal(meta.meta.extra.tpb4k.lookupSource, 'torrent-index');
});`
    );
  }
  write('provider/tpb4k-torrent-index.test.js', source);
}

function patchVersionReferences() {
  const allowed = new Set(['.js', '.json', '.md']);
  const excluded = new Set(['.git', 'node_modules', '.python-venv']);
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(target);
        continue;
      }
      if (!allowed.has(path.extname(entry.name))) continue;
      const original = fs.readFileSync(target, 'utf8');
      const updated = original.replace(/2\.7\.0-alpha\.15/g, '2.7.0-alpha.17');
      if (updated !== original) fs.writeFileSync(target, updated, 'utf8');
    }
  }
  visit(root);
}

function patchLockfile() {
  const relative = 'package-lock.json';
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) return;
  const value = JSON.parse(read(relative));
  value.version = '2.7.0-alpha.17';
  if (value.packages?.['']) value.packages[''].version = '2.7.0-alpha.17';
  write(relative, `${JSON.stringify(value, null, 2)}\n`);
}

function patchPackage() {
  const packageFile = 'package.json';
  const packageJson = JSON.parse(read(packageFile));
  packageJson.version = '2.7.0-alpha.17';
  packageJson.scripts ||= {};
  packageJson.scripts['test:tpb4k-all-19-playable'] =
    'node --test provider/tpb4k-all-19-playable-binding.test.js';
  packageJson.scripts['smoke:tpb4k-all-19-playable'] =
    'node scripts/tpb4k-all-19-playable-smoke.js';
  if (!String(packageJson.scripts['test:release'] || '').includes('provider/tpb4k-all-19-playable-binding.test.js')) {
    packageJson.scripts['test:release'] = `${packageJson.scripts['test:release']} provider/tpb4k-all-19-playable-binding.test.js`;
  }
  write(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function patchReadme() {
  const target = path.join(root, 'README.md');
  if (!fs.existsSync(target)) return;
  let source = fs.readFileSync(target, 'utf8');
  source = source.replace(/Current TPB4K candidate: 2\.7\.0-alpha\.15/g, 'Current TPB4K candidate: 2.7.0-alpha.17');
  source = source.replace(/Version `2\.7\.0-alpha\.15`/g, 'Version `2.7.0-alpha.17`');
  if (!source.includes('Alpha.16 binds only verified torrent identities')) {
    source += `\n## TPB4K all-19 playable binding (alpha.16)\n\nAlpha.16 binds only verified torrent identities to metadata-first studio cards before those cards are exposed. Unmatched metadata records are omitted instead of becoming dead version-1 cards. The poster and metadata identity remain TPDB/StashDB-derived, while the encoded version-2 ID carries the validated infoHash used immediately by the stream handler.\n`;
  }
  fs.writeFileSync(target, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
}

const codec = read('provider/tpb4k/id-codec.js');
if (!codec.includes('TORRENT_VERSION') || !codec.includes('normalizeBoundTorrent')) {
  fail('Current repository is missing the Phase 3 version-2 torrent ID codec');
}

patchProvider();
patchKnaben();
patchTorrentIndex();
patchStudioMetadata();
patchPlatformHybrid();
patchSourceContract();
patchRegressionTests();
patchPackage();
patchLockfile();
patchReadme();
patchVersionReferences();
console.log('Applied TPB4K all-19 playable metadata/torrent binding for 2.7.0-alpha.17.');
