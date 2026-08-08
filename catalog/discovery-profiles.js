'use strict';

const generated = require('./discovery-profiles.generated.json');

const option = (label, value = label, mode = 'native') => Object.freeze({ label, value, mode });

// Every legacy option below maps to a route/category already supported by that
// provider. This is intentionally small and source-specific.
const STATIC = Object.freeze({
  pornhub: Object.freeze([
    option('Reality'), option('Public'), option('POV'), option('Japanese'), option('Amateur'), option('Compilation'),
  ]),
  xvideos: Object.freeze([
    option('Uncensored'), option('Caught'), option('Workout'), option('Housewife'), option('Compilation'), option('Japanese'),
  ]),
  xnxx: Object.freeze([
    option('Most Viewed', 'hits'), option('Uncensored'), option('Japanese'), option('POV'), option('European'), option('Compilation'),
  ]),
  'xhamster.trending': Object.freeze([
    option('4K'), option('Uncensored'), option('JAV'), option('Massage'), option('Reality'), option('Public'),
  ]),
  'xhamster.best': Object.freeze([
    option('Best Today', 'Best (Daily)'), option('Best Week', 'Best (Weekly)'), option('Best Month', 'Best (Monthly)'),
    option('Best 2026', 'Best (2026)'), option('4K'), option('Fantasy'),
  ]),
  eporner: Object.freeze([
    option('4K · Viewed', '4k Porn (Most Viewed)'), option('1080p · New', 'HD 1080p (Most Recent)'),
    option('60 FPS', '60fps (Most Viewed)'), option('Japanese', 'Japanese (Weekly Top)'),
    option('POV', 'POV (Top Rated)'), option('Amateur · New', 'Amateur (Most Recent)'),
  ]),
  spankbang: Object.freeze([
    option('Trending'), option('New'), option('Popular'), option('4K Trending', '4K (Trending)'),
    option('4K New', '4K (New)'), option('Amateur New', 'Amateur (New)'),
  ]),
  porntrex: Object.freeze([
    option('Most Popular'), option('Top Rated'), option('4K', '4K porn'), option('Fantasy'), option('Japanese'), option('Celebrities'),
  ]),
  javhdporn: Object.freeze([
    option('Newest', 'Latest'), option('Most Viewed'), option('Uncensored'), option('FC2 PPV'),
    option('Tokyo Hot'), option('English Subtitle'),
  ]),
});

function generatedOptions(id) {
  return (generated[String(id || '')] || [])
    .map(item => Object.freeze({
      label: String(item?.label || '').trim(),
      value: String(item?.value || '').trim(),
      mode: String(item?.mode || 'facet').trim(),
      facet: String(item?.facet || '').trim(),
      count: Math.max(Number(item?.count || 0), 0),
    }))
    .filter(item => item.label && item.value && item.facet && item.count > 0);
}

function profileOptions(id) {
  const key = String(id || '');
  if (STATIC[key]) return STATIC[key];
  if (key.startsWith('tpb4k.') && !key.startsWith('tpb4k.stripchat.')) return generatedOptions(key);
  return [];
}

function applyDiscoveryProfile(catalog = {}) {
  const rows = profileOptions(catalog.id);
  if (!rows.length) return catalog;
  const extra = (Array.isArray(catalog.extra) ? catalog.extra : [])
    .filter(item => item?.name !== 'genre')
    .map(item => ({ ...item }));
  const genre = { name: 'genre', options: rows.map(item => item.label) };
  const skipIndex = extra.findIndex(item => item.name === 'skip');
  if (skipIndex >= 0) extra.splice(skipIndex, 0, genre);
  else extra.push(genre);
  return { ...catalog, extra };
}

function normalizeCatalogFacetArgs(args = {}) {
  const genre = String(args?.extra?.genre || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!genre) return args;
  const id = String(args.id || '');
  const selected = profileOptions(id).find(item => item.label.toLocaleLowerCase('en-US') === genre.toLocaleLowerCase('en-US'));
  if (!selected || id.startsWith('tpb4k.')) return args;
  return { ...args, extra: { ...(args.extra || {}), genre: selected.value } };
}

function resolveTpb4kFacet(catalogId, label) {
  const id = String(catalogId || '');
  if (!id.startsWith('tpb4k.') || id.startsWith('tpb4k.stripchat.')) return null;
  const wanted = String(label || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
  if (!wanted) return null;
  return generatedOptions(id).find(item => item.label.toLocaleLowerCase('en-US') === wanted) || null;
}

module.exports = {
  STATIC,
  applyDiscoveryProfile,
  normalizeCatalogFacetArgs,
  profileOptions,
  resolveTpb4kFacet,
};
