'use strict';

process.env.TPB4K_ENABLED = process.env.TPB4K_ENABLED || 'true';
process.env.ONLYPORN_SEARCH_SQLITE_ENABLED = process.env.ONLYPORN_SEARCH_SQLITE_ENABLED || 'true';
process.env.ONLYPORN_DISABLE_PERSISTENT_CACHE = 'false';

const { loadProvider } = require('../provider');
const { createSearchSqliteStore } = require('../provider/search-sqlite');

const query = String(process.argv[2] || 'uncensored')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim();

const rows = [
  ['tpb4k.hentai.all', 'series'],
  ['tpb4k.yesporn.recent', 'movie'],
  ['tpb4k.pornrips.recent', 'movie'],
  ['tpb4k.studio.vixen.top', 'movie'],
];

if (/^(?:1|true|yes)$/i.test(process.env.RUN_SLOW_SUKEBEI_SEARCH || '')) {
  rows.push(['tpb4k.sukebei.top', 'movie']);
}

async function one(id, type) {
  const started = Date.now();
  const response = await loadProvider(id).handleCatalog({
    id,
    type,
    extra: { search: query, skip: 0 },
  });
  const metas = Array.isArray(response?.metas) ? response.metas : [];
  return {
    id,
    ms: Date.now() - started,
    cards: metas.length,
    posters: metas.filter(meta => /^https:\/\//i.test(String(meta?.poster || ''))).length,
    titles: metas.slice(0, 5).map(meta => meta.name),
  };
}

(async () => {
  console.log(`SEARCH QUERY: ${query}`);
  console.log('Empty is valid when that source genuinely has no matching playable item.');
  console.log('The defect being tested is false-empty first-40 filtering, not forced results.');

  for (const [id, type] of rows) {
    try {
      console.log(JSON.stringify(await one(id, type)));
    } catch (error) {
      console.log(JSON.stringify({ id, error: String(error?.message || error) }));
    }
  }

  console.log('REPEAT FIRST CATALOG — expected to use exact-query SQLite cache:');
  console.log(JSON.stringify(await one(rows[0][0], rows[0][1])));

  const store = createSearchSqliteStore({ env: process.env });
  console.log('SEARCH SQLITE:', JSON.stringify(await store.stats()));
  await store.close();
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
