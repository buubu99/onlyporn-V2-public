'use strict';

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function searchTokens(query) {
  return [...new Set(
    normalizeSearchText(query)
      .split(' ')
      .map(value => value.trim())
      .filter(value => value.length > 1)
  )];
}

function visibleMetaText(meta = {}) {
  const values = [];
  for (const key of ['name', 'title', 'description']) {
    if (meta?.[key]) values.push(meta[key]);
  }
  for (const key of ['genres', 'tags', 'contentTags', 'cast']) {
    const value = meta?.[key];
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }
  return normalizeSearchText(values.join(' '));
}

function metaMatchesSearch(meta, query) {
  const tokens = searchTokens(query);
  if (!tokens.length) return true;
  const haystack = visibleMetaText(meta);
  return Boolean(haystack) && tokens.every(token => haystack.includes(token));
}

function filterCatalogResponse(response = {}, query = '') {
  const metas = Array.isArray(response?.metas) ? response.metas : [];
  return {
    ...(response || {}),
    metas: metas.filter(meta => metaMatchesSearch(meta, query)),
  };
}

module.exports = {
  filterCatalogResponse,
  metaMatchesSearch,
  normalizeSearchText,
  searchTokens,
  visibleMetaText,
};
