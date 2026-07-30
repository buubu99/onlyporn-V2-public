const { toCatalog } = require('./utils');
const catalog = require('./xhamster.json');
const segments = [
  'Trending',
  'Best',
];

const catalogs = segments.map(segment => toCatalog(segment, catalog));

module.exports = catalogs;
