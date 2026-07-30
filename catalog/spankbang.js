const catalog = require('./spankbang.json');

const opt = options => ({
  name: 'genre',
  options
});

// ✅ BASE SORTING
const baseCategories = [
  'Trending',
  'New',
  'Popular',
  'Upcoming'
];

// ✅ 4K (VALID ONLY)
const fourK = [
  '4K (Trending)',
  '4K (New)',
  '4K (Popular)'
];

// ✅ TOP SEARCH KEYWORDS
const searchGenres = [
  'Milf',
  'Teen',
  'Amateur',
  'Asian',
  'Big Tits',
  'Blonde',
  'Ebony',
  'Latina',
  'Lesbian',
  'Anal',
  'Creampie'
];

// ✅ SEARCH COMBINATIONS
const searchOptions = [];

const validSorts = ['Trending', 'New', 'Popular'];

for (const genre of searchGenres) {
  // always explicit
  searchOptions.push(`${genre} (Trending)`);

  for (const sort of validSorts.slice(1)) {
    searchOptions.push(`${genre} (${sort})`);
  }

  // ✅ 4K only with valid sorts
  searchOptions.push(`${genre} (4K Trending)`);
  searchOptions.push(`${genre} (4K New)`);
  searchOptions.push(`${genre} (4K Popular)`);
}

// ✅ FINAL OPTIONS
const options = [
  ...baseCategories,
  ...fourK,
  ...searchOptions
];

catalog.extra.push(opt(options));

module.exports = {
  spankbangCatalogs: [catalog]
};
