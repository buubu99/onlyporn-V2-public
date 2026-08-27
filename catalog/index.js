const shuffle = require('fisher-yates');
const { applyDiscoveryProfile } = require('./discovery-profiles');
const porntrexCatalog = require('./porntrex');
const { spankbangCatalogs } = require('./spankbang');
const xhamsterCatalogs = require('./xhamster');
const { catalogs: epornerCatalogs } = require('./eporner');
const xvideosCatalog = require('./xvideos.json');
const xnxxCatalog = require('./xnxx.json');
const javhdpornCatalog = require('./javhdporn.json');
const pornhubCatalog = require('./pornhub.json');
const {
  isTpb4kEnabled,
  tpb4kCatalogs: sourceTpb4kCatalogs,
} = require('./tpb4k');
function randomize(catalogs) {
  const arr = catalogs.map((_e, i) => i);
  return shuffle(arr).map(i => catalogs[i]);
}
function compactCatalogName(value) {
  return String(value || '').replace(/^OnlyPorn:\s*/i, '').trim();
}

const catalogNames = [
  'spankbang',
  'porntrex',
  'xhamster',
  'eporner',
  'xvideos',
  'xnxx',
  'javhdporn',
  'pornhub',
  ...(isTpb4kEnabled() ? ['tpb4k'] : []),
];

const COMPACT_EPORNER_GENRES = [
  '4k Porn',
  'HD 1080p',
  '60fps',
  'Anal',
  'POV',
  'Amateur',
  'Japanese',
  'Asian Porn',
  'Big Tits',
  'Teens',
  'Creampie',
];
const COMPACT_SPANKBANG_GENRES = [
  'Trending',
  'New',
  'Popular',
  'Upcoming',
  '4K (Trending)',
  '4K (New)',
  '4K (Popular)',
  'Milf (Trending)',
  'Teen (Trending)',
  'Amateur (Trending)',
  'Asian (Trending)',
  'Big Tits (Trending)',
  'Anal (Trending)',
  'Creampie (Trending)',
];

function compactLegacyCatalog(catalog) {
  const compact = { ...catalog, name: compactCatalogName(catalog.name) };

  // `extraSupported` duplicates the entries already declared in `extra`.
  delete compact.extraSupported;
  if (Array.isArray(compact.extra)) {
    compact.extra = compact.extra.map(item => {
      if (item.name !== 'genre') return { ...item };

      if (compact.id === 'eporner') {
        return { name: 'genre', options: COMPACT_EPORNER_GENRES };
      }

      if (compact.id === 'spankbang') {
        return { name: 'genre', options: COMPACT_SPANKBANG_GENRES };
      }

      return { ...item };
    });
  }

  return compact;
}
function compactTpb4kCatalog(catalog) {
  const searchOnly = (Array.isArray(catalog.extra) ? catalog.extra : [])
    .some(item => item?.name === 'search' && item?.isRequired === true);
  if (searchOnly) {
    return {
      id: catalog.id,
      type: catalog.type,
      name: compactCatalogName(catalog.name),
      extra: [{ name: 'search', isRequired: true }],
    };
  }

  const names = new Set(
    (Array.isArray(catalog.extra) ? catalog.extra : [])
      .map(item => String(item?.name || ''))
      .filter(name => name === 'search' || name === 'skip')
  );
  if (!names.has('skip')) names.add('skip');

  return {
    id: catalog.id,
    type: catalog.type,
    // Every studio row is already the curated Top view. Repeating "· Top" 18
    // times wastes more than 100 bytes in Stremio's strict 8 KiB manifest.
    name: compactCatalogName(catalog.name).replace(/\s*·\s*Top$/i, ''),
    extra: [...names].map(name => ({ name })),
  };
}

const legacyCatalogs = [
  ...epornerCatalogs,
  ...spankbangCatalogs,
  ...xhamsterCatalogs,
  porntrexCatalog,
  xvideosCatalog,
  xnxxCatalog,
  javhdpornCatalog,
  pornhubCatalog,
].map(compactLegacyCatalog);

const tpb4kCatalogs = sourceTpb4kCatalogs.map(compactTpb4kCatalog);
const tpb4kSearchCatalogs = tpb4kCatalogs.filter(catalog =>
  catalog.extra?.some(item => item.name === 'search' && item.isRequired === true)
);
const tpb4kBrowseCatalogs = tpb4kCatalogs.filter(catalog =>
  !tpb4kSearchCatalogs.includes(catalog)
);
const catalogs = [
  ...(isTpb4kEnabled() ? tpb4kSearchCatalogs : []),
  ...legacyCatalogs,
  ...(isTpb4kEnabled() ? tpb4kBrowseCatalogs : []),
].map(applyDiscoveryProfile);

const addonEnabled = id => getActiveProvider(id) !== null;

const getActiveProvider = id => {
  const value = String(id || '');

  for (const name of catalogNames) {
    if (
      value === name ||
      new RegExp(`^${name}(?:[.\\-_:]|$)`, 'i').test(value) ||
      value.startsWith(`onlyporn:${name}:`)
    ) {
      return name;
    }
  }

  return null;
};
module.exports = {
  catalogs,
  catalogNames,
  addonEnabled,
  getActiveProvider,
};
