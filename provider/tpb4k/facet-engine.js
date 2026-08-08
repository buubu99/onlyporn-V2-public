'use strict';

const { normalizeForMatch } = require('./search-engine');

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => item && typeof item === 'object'
    ? item.name || item.title || item.value || ''
    : item).map(item => String(item || '').trim()).filter(Boolean);
}

function performers(item = {}) {
  const castLinks = (Array.isArray(item.links) ? item.links : [])
    .filter(link => link && typeof link === 'object' && String(link.category || '').toLocaleLowerCase('en-US') === 'cast')
    .map(link => link.name);
  return [...strings(item.performers), ...castLinks].map(String).filter(Boolean);
}

function combinedText(item = {}) {
  return normalizeForMatch([
    item.title,
    item.name,
    item.description,
    item.quality,
    item.resolution,
    item.sceneCode,
    ...strings(item.tags),
    ...strings(item.genres),
    ...performers(item),
  ].filter(Boolean).join(' '));
}

function numberFromDescription(item, label) {
  const source = `${item?.description || ''}`;
  const match = source.match(new RegExp(`${label}:\\s*(\\d+(?:\\.\\d+)?)`, 'i'));
  return match ? Number(match[1]) : 0;
}

function itemYear(item = {}) {
  const source = [item.releaseDate, item.released, item.releaseInfo, item.description, item.title, item.name].filter(Boolean).join(' ');
  const match = String(source).match(/\b((?:19|20)\d{2})\b/);
  return match ? Number(match[1]) : 0;
}

function itemTimestamp(item = {}) {
  for (const value of [item.releaseDate, item.released, item.date, item.publishedAt]) {
    const stamp = Date.parse(String(value || ''));
    if (Number.isFinite(stamp)) return stamp;
  }
  return itemYear(item) || 0;
}

function ruleMatch(item, rule) {
  const text = combinedText(item);
  const description = String(item?.description || '');
  if (rule === 'quality_1080') return /\b(?:1080p|fhd)\b/.test(text);
  if (rule === 'codec_hevc') return /\b(?:hevc|x265)\b/.test(text);
  if (rule === 'jav_code') return /\b[a-z]{2,10}\s*\d{2,5}\b/.test(text);
  if (rule === 'new_words') return /\b(?:new|first|fresh)\b/.test(text);
  if (rule === 'step_fantasy') return /\bstep(?:mom|mother|dad|father|sister|brother|daughter|son|family|mommy)\b/.test(text);
  if (rule === 'pov') return /\bpov\b/.test(text);
  if (rule === 'wife_bride') return /\b(?:wife|bride|wedding)\b/.test(text);
  if (rule === 'cast_available') return performers(item).length > 0;
  if (rule === 'long_form') return numberFromDescription(item, 'Duration') >= 1800 || Number(item?.duration || 0) >= 1800;
  if (rule === 'compact_file') {
    const match = description.match(/Size:\s*(\d+(?:\.\d+)?)\s*MB/i);
    return Boolean(match && Number(match[1]) < 500);
  }
  if (rule === 'large_file') {
    if (Number(item?.size || 0) >= 1024 ** 3) return true;
    return /Size:\s*(?:\d+(?:\.\d+)?\s*GB|(?:1\d{3}|[2-9]\d{3,})\s*MB)/i.test(description);
  }
  return false;
}

function itemMatchesFacet(item = {}, selected = {}) {
  const facet = String(selected.facet || '');
  const value = String(selected.value || '');
  const wanted = normalizeForMatch(value);
  if (!facet || !value) return false;
  if (facet === 'sort') return true;
  if (facet === 'rule') return ruleMatch(item, value);
  if (facet === 'year') {
    const match = value.match(/^(\d{4})-(\d{4})$/);
    const year = itemYear(item);
    return Boolean(match && year >= Number(match[1]) && year <= Number(match[2]));
  }
  if (facet === 'performer') return performers(item).some(itemValue => normalizeForMatch(itemValue) === wanted);
  if (facet === 'quality' || facet === 'resolution') {
    return [item.quality, item.resolution, ...strings(item.genres), ...strings(item.tags)]
      .some(itemValue => normalizeForMatch(itemValue) === wanted);
  }
  if (facet === 'tag' || facet === 'genre') {
    return [...strings(item.tags), ...strings(item.genres), ...strings(item.contentTags)]
      .some(itemValue => normalizeForMatch(itemValue) === wanted);
  }
  if (facet === 'studio' || facet === 'series') return normalizeForMatch(item[facet]) === wanted;
  return false;
}

function sortFacetItems(items, selected = {}) {
  const output = [...(Array.isArray(items) ? items : [])];
  const mode = String(selected.facet || '') === 'sort' ? String(selected.value || '') : '';
  if (mode === 'title_asc') return output.sort((left, right) => String(left?.title || left?.name || '').localeCompare(String(right?.title || right?.name || '')));
  if (mode === 'rating_desc') return output.sort((left, right) => numberFromDescription(right, 'Rating') - numberFromDescription(left, 'Rating'));
  if (mode === 'seeders_desc') return output.sort((left, right) => Number(right?.seeders || 0) - Number(left?.seeders || 0));
  if (mode === 'release_desc') return output.sort((left, right) => itemTimestamp(right) - itemTimestamp(left));
  return output;
}

function applyFacet(items, selected) {
  const source = Array.isArray(items) ? items : [];
  const filtered = String(selected?.facet || '') === 'sort'
    ? source
    : source.filter(item => itemMatchesFacet(item, selected));
  return sortFacetItems(filtered, selected);
}

module.exports = {
  applyFacet,
  combinedText,
  itemMatchesFacet,
  itemTimestamp,
  itemYear,
  performers,
  ruleMatch,
  sortFacetItems,
};
