const catalog = require('./eporner.json');

const sortBy = [
  'Most Recent',
  'Weekly Top',
  'Monthly Top',
  'Most Viewed',
  'Top Rated',
];

const opt = options => ({
  'name': 'genre',
  options
});

const genres = [
  '4k Porn',
  'HD 1080p',
  '60fps',
  'Anal',
  'POV',
  'Amateur',
  'Students',
  'Japanese',
  'Asian Porn',
  'Big Tits',
  'Teens',
  'Family',
  'Creampie',
  'HQ Porn'
];

const options = []
for (const genre of genres) {
  for (const sort of sortBy) {
    options.push(`${genre} (${sort})`);
  }
}
catalog.extra.push((opt(options)));

module.exports = {
  sortBy,
  catalogs: [catalog]
};
