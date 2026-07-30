'use strict';

const DEFAULT_GAY_TAGS = Object.freeze([
  'gay',
  'gay sex',
  'male male',
  'male/male',
  'm/m',
  'm2m',
  'man on man',
  'men only',
  'bisexual male',
  'bi male',
]);

const DEFAULT_INTERRACIAL_TAGS = Object.freeze([
  'interracial',
  'interracial sex',
  'black male',
  'african american male',
  'african-american male',
  'ebony male',
  'bbc',
  'big black cock',
  'black guy white girl',
  'white girl black guy',
]);

const GAY_TAG_KEYS = new Set(DEFAULT_GAY_TAGS.map(value => labelMatchKey(value)));
const INTERRACIAL_TAG_KEYS = new Set(DEFAULT_INTERRACIAL_TAGS.map(value => labelMatchKey(value)));

const STRONG_TEXT_PATTERNS = Object.freeze([
  Object.freeze({ reason: 'gay', pattern: /\b(?:gay(?:\s+sex)?|male[\s\/-]+male|m2m|man\s+on\s+man|men\s+only|bisexual\s+male|bi\s+male)\b/i }),
  Object.freeze({ reason: 'interracial', pattern: /\b(?:interracial(?:\s+sex)?|black\s+male|african[\s-]+american\s+male|ebony\s+male|bbc|big\s+black\s+cock|black\s+guy\s+white\s+girl|white\s+girl\s+black\s+guy)\b/i }),
]);

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

function normalizeLabel(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/[^\p{L}\p{N}/+\-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function labelMatchKey(value) {
  return normalizeLabel(value)
    .replace(/[\/+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map(labelMatchKey)
    .filter(Boolean);
}

function itemName(value) {
  if (typeof value === 'string') return value;
  return value?.name || value?.label || value?.title || value?.value || '';
}

function collectLabels(item = {}) {
  const output = [];
  const seen = new Set();
  for (const collection of [
    item.tags,
    item.genres,
    item.categories,
    item.labels,
    item.keywords,
    item.contentTags,
    item.acts,
  ]) {
    const values = Array.isArray(collection) ? collection : collection ? [collection] : [];
    for (const value of values) {
      const label = normalizeLabel(itemName(value));
      if (!label || seen.has(label)) continue;
      seen.add(label);
      output.push(label);
    }
  }
  return output;
}

function readContentFilterConfig(env = process.env) {
  const blockGay = booleanValue(env.ONLYPORN_FILTER_GAY, true);
  const blockInterracial = booleanValue(env.ONLYPORN_FILTER_INTERRACIAL, true);
  const custom = parseCsv(env.ONLYPORN_FILTER_EXCLUDED_TAGS);
  const excluded = new Set(custom);
  if (blockGay) for (const value of DEFAULT_GAY_TAGS) excluded.add(labelMatchKey(value));
  if (blockInterracial) {
    for (const value of DEFAULT_INTERRACIAL_TAGS) excluded.add(labelMatchKey(value));
  }
  return Object.freeze({
    enabled: booleanValue(env.ONLYPORN_CONTENT_FILTER_ENABLED, true),
    blockGay,
    blockInterracial,
    blockUnknown: booleanValue(env.ONLYPORN_FILTER_UNKNOWN, false),
    inspectStrongText: booleanValue(env.ONLYPORN_FILTER_STRONG_TEXT, true),
    excludedTags: Object.freeze([...excluded]),
  });
}

function labelReason(label, config) {
  const normalized = normalizeLabel(label);
  const key = labelMatchKey(label);
  if (!normalized || !key) return '';
  const excluded = new Set(config.excludedTags || []);
  if (excluded.has(key)) {
    if (GAY_TAG_KEYS.has(key)) return 'gay';
    if (INTERRACIAL_TAG_KEYS.has(key)) return 'interracial';
    return `tag:${normalized}`;
  }
  if (config.blockGay && STRONG_TEXT_PATTERNS[0].pattern.test(normalized)) return 'gay';
  if (config.blockInterracial && STRONG_TEXT_PATTERNS[1].pattern.test(normalized)) {
    return 'interracial';
  }
  return '';
}

function strongTextReason(item = {}, config) {
  if (!config.inspectStrongText) return '';
  const text = [
    item.name,
    item.title,
    item.description,
    item.overview,
    item.summary,
    item.behaviorHints?.filename,
  ]
    .map(value => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  if (!text) return '';
  for (const entry of STRONG_TEXT_PATTERNS) {
    if (entry.reason === 'gay' && !config.blockGay) continue;
    if (entry.reason === 'interracial' && !config.blockInterracial) continue;
    if (entry.pattern.test(text)) return entry.reason;
  }
  return '';
}

function evaluateContent(item = {}, config = readContentFilterConfig()) {
  if (!config.enabled) return Object.freeze({ excluded: false, reason: '', labels: [] });
  const labels = collectLabels(item);
  for (const label of labels) {
    const reason = labelReason(label, config);
    if (reason) return Object.freeze({ excluded: true, reason, labels: Object.freeze(labels) });
  }
  const textReason = strongTextReason(item, config);
  if (textReason) return Object.freeze({ excluded: true, reason: textReason, labels: Object.freeze(labels) });
  if (config.blockUnknown && labels.length === 0 && item.contentClassificationKnown === false) {
    return Object.freeze({ excluded: true, reason: 'unknown', labels: Object.freeze(labels) });
  }
  return Object.freeze({ excluded: false, reason: '', labels: Object.freeze(labels) });
}

function filterItems(items, config = readContentFilterConfig()) {
  const kept = [];
  const reasons = {};
  let removed = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const evaluation = evaluateContent(item, config);
    if (!evaluation.excluded) {
      kept.push(item);
      continue;
    }
    removed += 1;
    reasons[evaluation.reason] = (reasons[evaluation.reason] || 0) + 1;
  }
  return Object.freeze({
    items: Object.freeze(kept),
    removed,
    reasons: Object.freeze(reasons),
  });
}

function filterCatalogResponse(response = {}, config = readContentFilterConfig()) {
  const filtered = filterItems(response.metas, config);
  return Object.freeze({
    response: { ...response, metas: [...filtered.items] },
    removed: filtered.removed,
    reasons: filtered.reasons,
  });
}

function filterMetaResponse(response = {}, config = readContentFilterConfig()) {
  const meta = response?.meta;
  if (!meta || typeof meta !== 'object' || !Object.keys(meta).length) {
    return Object.freeze({ response, removed: 0, reasons: Object.freeze({}) });
  }
  const evaluation = evaluateContent(meta, config);
  if (!evaluation.excluded) {
    return Object.freeze({ response, removed: 0, reasons: Object.freeze({}) });
  }
  return Object.freeze({
    response: { ...response, meta: {} },
    removed: 1,
    reasons: Object.freeze({ [evaluation.reason]: 1 }),
  });
}

function filterStreamResponse(response = {}, config = readContentFilterConfig()) {
  const filtered = filterItems(response.streams, config);
  return Object.freeze({
    response: { ...response, streams: [...filtered.items] },
    removed: filtered.removed,
    reasons: filtered.reasons,
  });
}

function filterManifestCatalogs(catalogs, config = readContentFilterConfig()) {
  const output = [];
  let removedOptions = 0;
  const reasons = {};
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    const extra = (Array.isArray(catalog?.extra) ? catalog.extra : []).map(entry => {
      if (!Array.isArray(entry?.options)) return { ...entry };
      const options = [];
      for (const option of entry.options) {
        const evaluation = evaluateContent({ tags: [option], title: option }, config);
        if (!evaluation.excluded) {
          options.push(option);
          continue;
        }
        removedOptions += 1;
        reasons[evaluation.reason] = (reasons[evaluation.reason] || 0) + 1;
      }
      return { ...entry, options };
    });
    output.push({ ...catalog, extra });
  }
  return Object.freeze({
    catalogs: Object.freeze(output),
    removedOptions,
    reasons: Object.freeze(reasons),
  });
}

module.exports = {
  DEFAULT_GAY_TAGS,
  DEFAULT_INTERRACIAL_TAGS,
  collectLabels,
  evaluateContent,
  filterCatalogResponse,
  filterItems,
  filterManifestCatalogs,
  filterMetaResponse,
  filterStreamResponse,
  labelMatchKey,
  normalizeLabel,
  readContentFilterConfig,
};
