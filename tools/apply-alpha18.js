#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { auditReleaseVersionAssertions, patchRetainedReleaseVersions } = require('./release-version-consistency');

const root = path.resolve(process.argv[2] || process.cwd());

function fail(message) { throw new Error(message); }
function read(relative) {
  const target = path.join(root, relative);
  if (!fs.existsSync(target)) fail(`Missing ${relative}`);
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
  if (source.indexOf(before, first + before.length) >= 0) fail(`Ambiguous anchor: ${label}`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}
function insertAfterUseStrict(source, line, label) {
  if (source.includes(line.trim())) return source;
  for (const anchor of ["'use strict';\n\n", "'use strict';\n"]) {
    if (source.includes(anchor)) return replaceOnce(source, anchor, `${anchor}${line}`, label);
  }
  fail(`Patch anchor not found: ${label}`);
}

function patchTorrentIndex() {
  let source = read('provider/tpb4k/torrent-index.js');
  source = insertAfterUseStrict(
    source,
    "const { studioSearchQueries } = require('./studio-aliases');\n",
    'torrent studio aliases import'
  );

  if (!source.includes('const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;')) {
    source = replaceOnce(
      source,
      "    const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), 100);\n",
      "    const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;\n    const normalizedLimit = Math.min(Math.max(Number.parseInt(String(limit || 40), 10) || 40, 1), maximumLimit);\n",
      'torrent binding-pool limit'
    );
  }

  if (!source.includes('const knabenQueries = studioSearchQueries(catalog);')) {
    const oldBlock = `    const knabenOrders = catalog?.playbackBindingPool ? ['seeders', 'date'] : ['seeders'];
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
`;
    const newBlock = `    const knabenOrders = catalog?.playbackBindingPool ? ['seeders', 'date'] : ['seeders'];
    const knabenQueries = studioSearchQueries(catalog);
    const knabenJobs = knabenQueries.flatMap(query =>
      knabenOrders.map(orderBy => Object.freeze({ query, orderBy }))
    );
    const knabenResults = await Promise.allSettled(
      knabenJobs.map(job => knabenClient.searchStudio(job.query, { orderBy: job.orderBy }))
    );
    for (let orderIndex = 0; orderIndex < knabenResults.length; orderIndex += 1) {
      const { query, orderBy } = knabenJobs[orderIndex];
      const result = knabenResults[orderIndex];
      if (result.status === 'rejected') {
        diagnostics.push({
          source: 'knaben',
          query,
          orderBy,
          outcome: 'error',
          error: compactText(result.reason?.message || result.reason),
        });
        continue;
      }
      diagnostics.push({
        source: 'knaben',
        query,
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
`;
    source = replaceOnce(source, oldBlock, newBlock, 'Knaben studio alias matrix');
  }

  if (!source.includes('source: \'hiddenbay-alias\'')) {
    const anchor = `    output.sort((left, right) => right.seeders - left.seeders || left.title.localeCompare(right.title));
`;
    const aliasFallback = `    // Some public indexes spell studio brands differently. After the canonical
    // HiddenBay window, query only approved aliases and keep the exact same
    // hash, seeder, deadline, and deduplication gates.
    if (catalog?.playbackBindingPool && output.length < normalizedLimit && Date.now() < deadlineAt) {
      const aliasQueries = studioSearchQueries(catalog).slice(1);
      for (const aliasQuery of aliasQueries) {
        if (output.length >= normalizedLimit || Date.now() >= deadlineAt) break;
        for (let aliasPage = 1; aliasPage <= 2; aliasPage += 1) {
          if (output.length >= normalizedLimit || Date.now() >= deadlineAt) break;
          const path = buildStudioSearchPath(aliasQuery, aliasPage, {
            category: config.torrentIndex?.category || TPB_UHD_CATEGORY,
            sort: config.torrentIndex?.sort || TPB_TOP_SORT,
          });
          let result;
          try {
            result = await fetchSearchPage(
              path,
              \`${'${catalog.id}'}:alias:${'${compactComparable(aliasQuery)}'}:${'${aliasPage}'}\`,
              deadlineAt
            );
          } catch (error) {
            diagnostics.push({
              source: 'hiddenbay-alias',
              query: aliasQuery,
              page: aliasPage,
              path,
              outcome: 'error',
              error: compactText(error?.message || error),
            });
            break;
          }
          diagnostics.push({
            source: 'hiddenbay-alias',
            query: aliasQuery,
            page: aliasPage,
            path,
            mirror: result.mirror,
            records: result.records.length,
            attempts: result.attempts,
          });
          for (const record of result.records) {
            const infoHash = extractInfoHash(record.infoHash || record.magnetLink);
            const key = infoHash || record.sourceId;
            if (!key || Number(record.seeders || 0) < minimumSeeders || seen.has(key)) continue;
            seen.add(key);
            privateIndex.remember(record, catalog);
            output.push(publicTorrentItem(record, catalog));
            if (output.length >= normalizedLimit) break;
          }
          if (result.records.length < TPB_PAGE_SIZE || result.records.length === 0) break;
        }
      }
    }

    output.sort((left, right) => right.seeders - left.seeders || left.title.localeCompare(right.title));
`;
    source = replaceOnce(source, anchor, aliasFallback, 'HiddenBay studio alias fallback');
  }
  write('provider/tpb4k/torrent-index.js', source);
}

function patchProvider() {
  let source = read('provider/tpb4k.js');
  if (!source.includes('const torrentPoolLimit = 300;')) {
    source = replaceOnce(
      source,
      '        const torrentPoolLimit = 100;\n',
      '        const torrentPoolLimit = 300;\n',
      'studio torrent pool'
    );
  }

  if (!source.includes('function alpha18DiagnosticStudioKey')) {
    const anchor = 'function safePoster(value) {\n';
    const helpers = `function alpha18DiagnosticStudioKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function alpha18MergeReasons(...values) {
  const output = {};
  for (const value of values) {
    for (const [key, amount] of Object.entries(value || {})) {
      output[key] = (output[key] || 0) + Math.max(Number(amount || 0), 0);
    }
  }
  return output;
}

function safePoster(value) {
`;
    source = replaceOnce(source, anchor, helpers, 'provider diagnostic helpers');
  }

  if (source.includes('const diagnostics = adapter.diagnostics?.() || {};')) {
    source = source.replace(
      'const diagnostics = adapter.diagnostics?.() || {};',
      'const diagnostics = adapter.diagnostics?.({ catalog: definition, skip, limit: config.catalogLimit }) || {};'
    );
  }

  if (!source.includes('let diagnosticsStale = false;')) {
    source = replaceOnce(
      source,
      '    let platformHybrid;\n',
      '    let platformHybrid;\n    let diagnosticsStale = false;\n',
      'provider diagnostics stale flag'
    );
  }

  if (!source.includes('alpha18DiagnosticStudioKey(metadataCatalog.studio)')) {
    const anchor = `      platformHybrid = diagnostics.platformHybrid;
`;
    const guarded = `      platformHybrid = diagnostics.platformHybrid;
      if (
        metadataCatalog?.studio && definition.studio &&
        alpha18DiagnosticStudioKey(metadataCatalog.studio) !== alpha18DiagnosticStudioKey(definition.studio)
      ) {
        // Adapters historically exposed one mutable lastDiagnostics value. A
        // parallel AIOStreams home request can overwrite it between await and
        // logging. Never label one studio with another studio's diagnostics.
        metadataCatalog = undefined;
        diagnosticsStale = true;
      }
`;
    source = replaceOnce(source, anchor, guarded, 'request-safe studio diagnostics');
  }

  if (!source.includes('metadataStageRemoved: metadataFiltered')) {
    const old = `        ...(studioPlaybackBinding ? { studioPlaybackBinding } : {}),
        contentFilter: {
          removed: contentFiltered.removed,
          reasons: contentFiltered.reasons,
        },
`;
    const replacement = `        ...(studioPlaybackBinding ? { studioPlaybackBinding } : {}),
        ...(diagnosticsStale ? { diagnosticsStale: true } : {}),
        contentFilter: (() => {
          const metadataFiltered = Math.max(Number(metadataCatalog?.filtered || 0), 0);
          return {
            removed: metadataFiltered + contentFiltered.removed,
            metadataStageRemoved: metadataFiltered,
            providerStageRemoved: contentFiltered.removed,
            reasons: alpha18MergeReasons(metadataCatalog?.filterReasons, contentFiltered.reasons),
          };
        })(),
`;
    source = replaceOnce(source, old, replacement, 'combined content-filter diagnostics');
  }
  write('provider/tpb4k.js', source);
}

function patchSukebei() {
  let source = read('provider/tpb4k/sukebei-metadata.js');
  if (!source.includes('fallbackPosterUrl')) {
    source = replaceOnce(
      source,
      "const { normalizeSearchTitle, significantTokens } = require('./poster-enrichment');\n",
      "const { fallbackPosterUrl, normalizeSearchTitle, significantTokens } = require('./poster-enrichment');\n",
      'Sukebei fallback import'
    );
  }
  if (!source.includes('rssFallbackCards: 0')) {
    source = source.replace(/(\s+nativeImages: 0,\n)/g, '$1      rssFallbackCards: 0,\n');
    if (!source.includes('rssFallbackCards: 0')) fail('Sukebei fallback stats anchor not found');
  }
  if (!source.includes("lookupSource: 'sukebei-rss-fallback'")) {
    const anchor = '    const window = allowed.slice(safeSkip, safeSkip + safeLimit);\n';
    const block = `    // A transient metadata/poster outage must not erase valid RSS torrent
    // identities. Fallback cards retain the real RSS hash and use the honest
    // Sukebei branded asset; they never invent scene art or a debrid claim.
    const needed = safeSkip + safeLimit;
    if (allowed.length < needed) {
      const poster = fallbackPosterUrl('sukebei', config.posterAssetBaseUrl);
      const existing = new Set(allowed.map(item => String(item.sourceId)));
      for (const source of normalized) {
        if (allowed.length >= needed || existing.has(String(source.sourceId))) continue;
        const parsedMagnet = parseMagnet(source.magnetLink || source.magnet);
        const infoHash = normalizeInfoHash(source.infoHash || parsedMagnet?.infoHash);
        if (!infoHash) continue;
        const evaluation = evaluateContent(source, filterConfig);
        if (evaluation.excluded) {
          stats.filtered += 1;
          incrementCounter(stats.filterReasons, evaluation.reason);
          continue;
        }
        const fallback = Object.freeze({
          ...source,
          infoHash,
          poster,
          background: poster,
          description: compactText(source.description || 'Sukebei RSS torrent · scene artwork pending'),
          lookupSource: 'sukebei-rss-fallback',
          contentClassificationKnown: Array.isArray(source.tags) && source.tags.length > 0,
        });
        allowed.push(fallback);
        existing.add(String(source.sourceId));
        stats.rssFallbackCards += 1;
      }
    }

    const window = allowed.slice(safeSkip, safeSkip + safeLimit);
`;
    source = replaceOnce(source, anchor, block, 'Sukebei outage fallback');
  }
  write('provider/tpb4k/sukebei-metadata.js', source);
}

function patchAddon() {
  let source = read('addon.js');
  if (!source.includes("idPrefixes: ['onlyporn:', 'hmm-']")) {
    source = replaceOnce(
      source,
      "  resources: ['catalog', 'stream', 'meta'],\n",
      `  resources: [
    'catalog',
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['onlyporn:', 'hmm-'] },
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['onlyporn:', 'hmm-'] },
  ],
`,
      'manifest idPrefixes'
    );
  }
  write('addon.js', source);
}

function patchRetainedTests() {
  const relative = 'provider/tpb4k-all-19-playable-binding.test.js';
  let source = read(relative);
  const start = source.indexOf("test('a studio-unique release date safely binds when title formatting differs'");
  const end = source.indexOf("test('OnlyFans hybrid torrent fallback rows cannot replace metadata poster identities'", start);
  if (start >= 0 && end > start) {
    source = `${source.slice(0, start)}test('release date alone never binds an unrelated studio torrent', () => {
  const definition = catalogDefinitions.find(item => item.id === 'tpb4k.studio.dorcelclub.top');
  const result = bindStudioPlayback({
    catalog: definition,
    metadataItems: [{ sourceId: 'tpdb:dorcel-date-only', title: 'Completely Different Editorial Title', studio: 'DorcelClub', releaseDate: '2026-07-21', poster: 'https://images.example/dorcel.jpg' }],
    torrentItems: [{ sourceId: 'knaben:date-only', title: 'DorcelClub 2026 07 21 Unrelated Release 2160p', studio: 'DorcelClub', infoHash: HASHES, seeders: 9, indexer: 'knaben' }],
  });
  assert.equal(result.items.length, 0);
});

${source.slice(end)}`;
  }
  write(relative, source);
}

function patchReleaseVersionAssertions() {
  const result = patchRetainedReleaseVersions(root, '2.7.0-alpha.17', '2.7.0-alpha.18');
  if (!result.changed.length) fail('No retained alpha.17 release-version assertions were updated; unsupported base');
  console.log(`Updated retained release-version assertions in ${result.changed.length} test files.`);
}

function patchPackage() {
  const pkg = JSON.parse(read('package.json'));
  pkg.version = '2.7.0-alpha.18';
  pkg.scripts ||= {};
  pkg.scripts['test:tpb4k-alpha18'] = 'node --test provider/tpb4k-alpha18-regression.test.js provider/tpb4k-hentaimama-series.test.js provider/tpb4k-all-19-playable-binding.test.js';
  pkg.scripts['smoke:tpb4k-alpha18'] = 'node scripts/tpb4k-alpha18-acceptance.js';
  if (!String(pkg.scripts['test:release'] || '').includes('provider/tpb4k-alpha18-regression.test.js')) {
    pkg.scripts['test:release'] = `${pkg.scripts['test:release'] || 'node --test'} provider/tpb4k-alpha18-regression.test.js`;
  }
  write('package.json', JSON.stringify(pkg, null, 2));

  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.version = pkg.version;
    if (lock.packages?.['']) lock.packages[''].version = pkg.version;
    write('package-lock.json', JSON.stringify(lock, null, 2));
  }
}

function validate() {
  const required = [
    'provider/tpb4k/hentaimama-series.js',
    'provider/tpb4k/studio-playback-binding.js',
    'provider/tpb4k/studio-aliases.js',
    'provider/tpb4k/torrent-index.js',
    'provider/tpb4k/sukebei-metadata.js',
    'provider/tpb4k.js',
    'addon.js',
    'provider/tpb4k-alpha18-regression.test.js',
    'scripts/tpb4k-alpha18-acceptance.js',
  ];
  for (const relative of required) {
    const check = spawnSync(process.execPath, ['--check', path.join(root, relative)], { encoding: 'utf8' });
    if (check.status !== 0) fail(`${relative}: ${check.stderr || check.stdout}`);
  }
  const binding = read('provider/tpb4k/studio-playback-binding.js');
  for (const unsafe of ['unique-release-date', 'date-and-performer']) {
    if (binding.includes(`reason: '${unsafe}'`)) fail(`Unsafe binding remains: ${unsafe}`);
  }
  if (!read('provider/tpb4k/hentaimama-series.js').includes("catalog?.mode === 'top'")) fail('Top-specific Hentai gate missing');
  if (!read('provider/tpb4k/hentaimama-series.js').includes('const requireEpisodes = Boolean(loadOptions.requireEpisodes);')) fail('Hentai metadata/episode separation missing');
  if (!read('provider/tpb4k-phase2c.test.js').includes("assert.equal(pkg.version, '2.7.0-alpha.18');")) fail('Phase 2C alpha.18 assertion missing');
  if (!read('provider/tpb4k/sukebei-metadata.js').includes("lookupSource: 'sukebei-rss-fallback'")) fail('Sukebei fallback missing');
  if (!read('provider/tpb4k/torrent-index.js').includes('const maximumLimit = catalog?.playbackBindingPool ? 300 : 100;')) fail('300-record studio torrent pool missing');
  if (!read('addon.js').includes("idPrefixes: ['onlyporn:', 'hmm-']")) fail('OnlyPorn resource prefixes missing');
  auditReleaseVersionAssertions(root, '2.7.0-alpha.18');
}

patchTorrentIndex();
patchProvider();
patchSukebei();
patchAddon();
patchRetainedTests();
patchReleaseVersionAssertions();
patchPackage();
validate();
console.log('Applied 2.7.0-alpha.18 R3: complete retained-version consistency plus Hentai Top, strict studio binding, Sukebei fallback, resource prefixes, and truthful diagnostics.');
