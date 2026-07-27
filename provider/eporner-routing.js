const sortByMappings = {
  'Most Recent': '',
  'Weekly Top': 'SORT-top-weekly',
  'Monthly Top': 'SORT-top-monthly',
  'Most Viewed': 'SORT-most-viewed',
  'Top Rated': 'SORT-top-rated',
};

function toSearchSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseGenreSelection(value) {
  const match = String(value || '').trim().match(/^(.*?)(?:\s*\(([^)]+)\))?$/);
  return {
    genre: match?.[1]?.trim() || '',
    sort: match?.[2]?.trim() || 'Most Recent',
  };
}

function buildEpornerGenreUrl(baseUrl, value) {
  const selection = parseGenreSelection(value);
  if (!selection.genre) return baseUrl;

  const slug = toSearchSlug(selection.genre);
  const sortSegment = sortByMappings[selection.sort] ?? '';
  const base = `${String(baseUrl).replace(/\/$/, '')}/search/${slug}/`;
  return sortSegment ? `${base}${sortSegment}/` : base;
}

module.exports = {
  buildEpornerGenreUrl,
  parseGenreSelection,
  sortByMappings,
  toSearchSlug,
};
