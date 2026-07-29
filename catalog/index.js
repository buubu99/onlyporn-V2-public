const shuffle = require('fisher-yates');
const porntrexCatalog = require('./porntrex');
const { spankbangCatalogs } = require('./spankbang');
const xhamsterCatalogs = require('./xhamster');
const { catalogs: epornerCatalogs } = require('./eporner');
const xvideosCatalog = require('./xvideos.json');
const xnxxCatalog = require('./xnxx.json');
const javhdpornCatalog = require('./javhdporn.json');
const pornhubCatalog = require('./pornhub.json');

function randomize(catalogs) {
  const arr = catalogs.map((_e, i) => i);
  return shuffle(arr).map(i => catalogs[i]);
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
];

const catalogs = [
  ...epornerCatalogs,
  ...spankbangCatalogs,
  ...xhamsterCatalogs,
  porntrexCatalog,
  xvideosCatalog,
  xnxxCatalog,
  javhdpornCatalog,
  pornhubCatalog
];

const addonEnabled = (id) => {
  return getActiveProvider(id) !== null;
}

const getActiveProvider = (id) => {
  const value = String(id || '');

  for (const name of catalogNames) {
    if (
      value === name ||
      new RegExp(`^${name}(?:[.\-_:]|$)`, 'i').test(value) ||
      value.startsWith(`onlyporn:${name}:`)
    ) {
      return name;
    }
  }

  return null;
}

module.exports = {
  catalogs,
  catalogNames,
  addonEnabled,
  getActiveProvider
};