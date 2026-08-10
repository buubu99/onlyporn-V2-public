'use strict';

const TARGET_CATALOGS = new Set([
  'tpb4k.sukebei.top',
  'tpb4k.sukebei.hentai',
]);

const MAX_SEARCH_VARIANTS = 6;

// Curated deterministic aliases only. Do not add automatic/runtime translation.
// Keep minor/age-coded sexual terms out of this table.
const SHARED_RULES = [
  {
    phrases: ['uncensored'],
    translations: ['無修正', 'モザイクなし', 'モザイク除去', 'モザイク破壊', '破壊版'],
  },
  { phrases: ['big breasts'], translations: ['巨乳'] },
  { phrases: ['married woman', 'wife'], translations: ['人妻'] },
  { phrases: ['female teacher', 'teacher'], translations: ['女教師'] },
  { phrases: ['office lady'], translations: ['OL'] },
  { phrases: ['masturbation'], translations: ['オナニー'] },
  { phrases: ['pantyhose'], translations: ['パンスト'] },
  { phrases: ['stockings'], translations: ['ストッキング'] },
  { phrases: ['squirting'], translations: ['潮吹き'] },
  { phrases: ['threesome'], translations: ['3P'] },
  { phrases: ['mature'], translations: ['熟女'] },
  { phrases: ['amateur'], translations: ['素人'] },
  { phrases: ['nurse'], translations: ['ナース'] },
  { phrases: ['cosplay'], translations: ['コスプレ'] },
  { phrases: ['creampie'], translations: ['中出し'] },
  { phrases: ['lesbian'], translations: ['レズ'] },
  { phrases: ['bondage'], translations: ['緊縛'] },
  { phrases: ['massage'], translations: ['マッサージ'] },
  { phrases: ['swimsuit'], translations: ['水着'] },
  { phrases: ['anal'], translations: ['アナル'] },
  { phrases: ['maid'], translations: ['メイド'] },
  { phrases: ['pov'], translations: ['主観'] },
];

const HENTAI_ONLY_RULES = [
  { phrases: ['tentacles', 'tentacle'], translations: ['触手'] },
  { phrases: ['futanari'], translations: ['ふたなり'] },
  { phrases: ['hypnosis', 'hypnotized'], translations: ['催眠'] },
];

function compact(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseRegex(phrase) {
  // All curated source phrases are ASCII English. Explicit ASCII word edges
  // prevent "anal" matching "analysis", while still allowing punctuation.
  return new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(phrase)})(?=$|[^A-Za-z0-9])`, 'i');
}

function findMatchingPhrase(query, phrases = []) {
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  return sorted.find(phrase => phraseRegex(phrase).test(query)) || '';
}

function replacePhrase(query, phrase, replacement) {
  const re = phraseRegex(phrase);
  return compact(query.replace(re, (_match, prefix) => `${prefix}${replacement}`));
}

function rulesForCatalog(catalogId) {
  if (!TARGET_CATALOGS.has(catalogId)) return [];
  return catalogId === 'tpb4k.sukebei.hentai'
    ? [...SHARED_RULES, ...HENTAI_ONLY_RULES]
    : SHARED_RULES;
}

function sortRulesLongestFirst(rules = []) {
  return [...rules].sort((a, b) => {
    const aLen = Math.max(...a.phrases.map(value => value.length));
    const bLen = Math.max(...b.phrases.map(value => value.length));
    return bLen - aLen;
  });
}

function dedupe(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = compact(value);
    const key = normalized.toLocaleLowerCase('en-US');
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * Expand one customer search into original + deterministic Japanese variants.
 *
 * Examples:
 *   SONE 620 uncensored
 *     -> original + five Japanese uncensored-family variants (max 6 total)
 *
 *   big breasts nurse
 *     -> original + 巨乳 ナース
 *
 * Unknown terms remain exactly where they were; only known English phrases are
 * replaced. Multiple ordinary aliases are combined into one translated query.
 */
function expandSukebeiSearchQueries(search, {
  catalogId = '',
  maxVariants = MAX_SEARCH_VARIANTS,
} = {}) {
  const original = compact(search);
  if (!original || !TARGET_CATALOGS.has(catalogId)) {
    return original ? [original] : [];
  }

  const cap = Math.max(1, Math.min(Number(maxVariants) || MAX_SEARCH_VARIANTS, MAX_SEARCH_VARIANTS));
  let translated = [original];
  let matchedAny = false;

  for (const rule of sortRulesLongestFirst(rulesForCatalog(catalogId))) {
    const next = [];

    for (const query of translated) {
      const phrase = findMatchingPhrase(query, rule.phrases);
      if (!phrase) {
        next.push(query);
        continue;
      }

      matchedAny = true;
      for (const replacement of rule.translations) {
        next.push(replacePhrase(query, phrase, replacement));
      }
    }

    translated = dedupe(next).slice(0, Math.max(1, cap - 1));
  }

  if (!matchedAny) return [original];

  const JapaneseVariants = dedupe(translated)
    .filter(value => value.toLocaleLowerCase('en-US') !== original.toLocaleLowerCase('en-US'));

  return dedupe([original, ...JapaneseVariants]).slice(0, cap);
}

function isSukebeiAliasCatalog(catalogId) {
  return TARGET_CATALOGS.has(String(catalogId || ''));
}

module.exports = {
  MAX_SEARCH_VARIANTS,
  expandSukebeiSearchQueries,
  isSukebeiAliasCatalog,
};
