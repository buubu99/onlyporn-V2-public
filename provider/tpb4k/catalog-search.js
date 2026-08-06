'use strict';

const DEFAULT_PAGE_SIZE = 40;
const MAX_SEARCH_LENGTH = 120;

function compactSearch(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_LENGTH);
}

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSkip(value) {
  return Math.max(
    Number.parseInt(String(value || 0), 10) || 0,
    0
  );
}

function listText(value) {
  if (!Array.isArray(value)) return '';
  return value
    .map(item => {
      if (item && typeof item === 'object') {
        return [
          item.name,
          item.title,
          item.value,
          item.category,
        ].filter(Boolean).join(' ');
      }
      return String(item || '');
    })
    .filter(Boolean)
    .join(' ');
}

function field(value, weight) {
  const text = normalizeForMatch(value);
  return text ? Object.freeze({ text, weight }) : null;
}

function metaSearchFields(meta = {}) {
  const onlyporn = meta?.extra?.onlyporn || {};
  return [
    field(meta.name, 150),
    field(listText(meta.tags), 120),
    field(listText(meta.genres), 110),
    field(listText(meta.links), 100),
    field(meta.description, 40),
    field(onlyporn.sceneCode, 150),
    field(listText(onlyporn.tags), 120),
    field(onlyporn.source, 20),
    field(onlyporn.metadataProvider, 20),
    field(onlyporn.lookupSource, 20),
  ].filter(Boolean);
}

function scoreMeta(meta, rawSearch) {
  const search = normalizeForMatch(compactSearch(rawSearch));
  if (!search) return -1;

  const tokens = search.split(' ').filter(Boolean);
  if (!tokens.length) return -1;

  const fields = metaSearchFields(meta);
  const combined = fields.map(item => item.text).join(' ');

  // Every entered word must exist somewhere in this catalog card's
  // normalized metadata. Words may match across title, tags, performer,
  // studio/genre, description, and scene code.
  if (!tokens.every(token => combined.includes(token))) return -1;

  const title = normalizeForMatch(meta?.name);
  let score = 0;

  if (title === search) score += 2_000;
  else if (title.startsWith(search)) score += 1_000;
  else if (title.includes(search)) score += 700;

  for (const token of tokens) {
    for (const item of fields) {
      if (item.text === token) score += item.weight * 4;
      else if (item.text.startsWith(token)) score += item.weight * 2;
      else if (item.text.includes(token)) score += item.weight;
    }
  }

  return score;
}

function searchMetas(metas, search) {
  return (Array.isArray(metas) ? metas : [])
    .map((meta, index) => ({
      meta,
      index,
      score: scoreMeta(meta, search),
    }))
    .filter(item => item.score >= 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.index - right.index
    )
    .map(item => item.meta);
}

function isTpb4kId(value) {
  return String(value || '').startsWith('tpb4k.');
}

function isStripchatId(value) {
  return String(value || '').startsWith('tpb4k.stripchat.');
}

function isTpb4kSearchRequest(args = {}) {
  return isTpb4kId(args.id) &&
    Boolean(compactSearch(args?.extra?.search));
}

function toProviderCatalogArgs(args = {}) {
  if (!isTpb4kSearchRequest(args)) return args;

  // The established TPB4K provider must continue receiving an ordinary
  // browse request. Its current cache, prewarm, metadata, poster, playback,
  // and Sukebei paths therefore remain completely unchanged.
  const extra = {
    ...(args.extra || {}),
    skip: 0,
  };
  delete extra.search;

  return {
    ...args,
    extra,
  };
}

function applyTpb4kCatalogSearch(response, args = {}, options = {}) {
  if (!isTpb4kSearchRequest(args)) return response;
  if (isStripchatId(args.id)) return { metas: [] };

  const search = compactSearch(args?.extra?.search);
  const skip = normalizeSkip(args?.extra?.skip);
  const pageSize = Math.min(
    Math.max(
      Number.parseInt(String(options.pageSize || DEFAULT_PAGE_SIZE), 10) ||
        DEFAULT_PAGE_SIZE,
      1
    ),
    100
  );

  const ranked = searchMetas(response?.metas, search);

  return {
    ...(response && typeof response === 'object' ? response : {}),
    metas: ranked.slice(skip, skip + pageSize),
  };
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  applyTpb4kCatalogSearch,
  compactSearch,
  isStripchatId,
  isTpb4kId,
  isTpb4kSearchRequest,
  metaSearchFields,
  normalizeForMatch,
  scoreMeta,
  searchMetas,
  toProviderCatalogArgs,
};
