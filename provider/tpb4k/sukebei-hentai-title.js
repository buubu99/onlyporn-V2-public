'use strict';

const VIDEO_EXTENSION_RE = /\.(?:mkv|mp4|m4v|webm|avi|wmv|flv|ts|mov)$/i;
const TECHNICAL_RE = /\b(?:4320p|2160p|1440p|1080p|810p|720p|576p|540p|480p|360p|8k|4k|2k|fhd|uhd|hd|sd|hevc|avc|x26[45]|h26[45]|hi10p|10-?bit|8-?bit|bluray|blu-?ray|bdrip|bdremux|web-?dl|web-?rip|dvd(?:rip)?|aac|flac|ac3|dts|opus|multi(?:-?sub)?|dual-?audio|raw|subbed|uncensored|decensored|censored|uncen|decen)\b/giu;
const UNCENSORED_RE = /\b(?:uncensored|decensored|uncen(?:sored)?|decen(?:sored)?|uncut|no[ ._-]?mosaic|de[ ._-]?mosaic(?:ed)?)\b|無修正|修正なし|無修|无码|無碼|去马赛克|去馬賽克|破解|모자이크\s*없음|무수정|노모/iu;
const CENSORED_RE = /\b(?:censored|mosaic(?:ed)?)\b|有码|有碼|モザイク|修正版/iu;
const ENGLISH_SUB_RE = /\b(?:english|eng)(?:[ ._-]*(?:sub|subs|subbed|subtitle|subtitles))\b|\bengsub\b/iu;
const CHINESE_SUB_RE = /\b(?:chinese|chi|chs|cht)(?:[ ._-]*(?:sub|subs|subbed|subtitle|subtitles))\b|简体|簡體|繁體|中文字幕/iu;
const COMPLETE_RE = /\b(?:batch|complete|collection|box[ ._-]?set|all[ ._-]?(?:episodes|eps)|full[ ._-]?(?:series|season)|season[ ._-]?pack)\b|全\s*\d+\s*(?:話|话|集)|全集|全話|完結|완결/iu;

function cleanText(value, maximum = 2_000) {
  return String(value || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function stripMarkup(value) {
  return cleanText(String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>'));
}

function removeLeadingReleaseBlocks(value) {
  let output = cleanText(value);
  for (let count = 0; count < 5; count += 1) {
    const next = output.replace(/^\s*(?:\[[^\]]{1,80}\]|\([^)]{1,80}\)|【[^】]{1,80}】)\s*/u, '');
    if (next === output) break;
    output = next;
  }
  return output;
}

function titleWithoutEpisode(value) {
  return cleanText(value)
    .replace(/\bS\d{1,2}\s*E\d{1,4}(?:v\d+)?\b/giu, ' ')
    .replace(/\b(?:episode|ep|ova|oad|special|chapter|part|act)\.?\s*#?\s*\d{1,4}(?:v\d+)?\b/giu, ' ')
    .replace(/第\s*\d{1,4}\s*(?:話|话|集|回)/gu, ' ')
    .replace(/(?:^|\s)-\s*\d{1,4}(?:v\d+)?(?=\s|$)/giu, ' ')
    .replace(/\s+\d{1,3}(?:v\d+)?(?=\s*(?:\[[^\]]+\]|\([^)]*\)|$))/giu, ' ');
}

function cleanReleaseTitle(value) {
  let output = removeLeadingReleaseBlocks(value)
    .replace(VIDEO_EXTENSION_RE, ' ')
    .replace(/\[[a-f0-9]{8}\]/giu, ' ')
    .replace(TECHNICAL_RE, ' ')
    .replace(/\b(?:english|eng|japanese|jpn|chinese|chs|cht)[ ._-]*(?:audio|sub|subs|subbed|subtitle|subtitles)\b/giu, ' ');
  output = titleWithoutEpisode(output)
    .replace(/[._]+/g, ' ')
    .replace(/\s[-–—|]+\s/g, ' ')
    .replace(/[\[\](){}【】［］「」『』]/gu, ' ');
  return cleanText(output, 300) || cleanText(value, 300);
}

function normalizedTitle(value) {
  return cleanReleaseTitle(value)
    .toLocaleLowerCase('en-US')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(value) {
  return normalizedTitle(value).split(' ').filter(token => token.length >= 2 || /[^\x00-\x7f]/u.test(token));
}

function titleSimilarity(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const compactA = a.replace(/\s+/g, '');
  const compactB = b.replace(/\s+/g, '');
  if (Math.min(compactA.length, compactB.length) >= 6 && (compactA.includes(compactB) || compactB.includes(compactA))) {
    return Math.min(compactA.length, compactB.length) / Math.max(compactA.length, compactB.length) >= 0.62 ? 0.94 : 0.82;
  }
  const tokensA = new Set(titleTokens(a));
  const tokensB = new Set(titleTokens(b));
  if (!tokensA.size || !tokensB.size) return 0;
  let common = 0;
  for (const token of tokensA) if (tokensB.has(token)) common += 1;
  const smallerCoverage = common / Math.min(tokensA.size, tokensB.size);
  const union = new Set([...tokensA, ...tokensB]).size;
  const jaccard = union ? common / union : 0;
  const prefix = [...tokensA][0] === [...tokensB][0] ? 0.08 : 0;
  return Math.min((smallerCoverage * 0.72) + (jaccard * 0.28) + prefix, 1);
}

function metadataAliases(metadata = {}) {
  const values = [
    metadata.title,
    metadata.englishTitle,
    metadata.nativeTitle,
    ...(Array.isArray(metadata.synonyms) ? metadata.synonyms : []),
  ].map(value => cleanText(value, 300)).filter(value => value.length >= 2);
  return [...new Set(values)];
}

function bestMetadataMatch(releaseTitle, metadata = {}) {
  let best = Object.freeze({ score: 0, alias: '' });
  for (const alias of metadataAliases(metadata)) {
    const score = titleSimilarity(releaseTitle, alias);
    if (score > best.score) best = Object.freeze({ score, alias });
  }
  return best;
}

function extractEpisodeNumber(value) {
  const source = removeLeadingReleaseBlocks(value).replace(VIDEO_EXTENSION_RE, ' ');
  for (const pattern of [
    /\bS(\d{1,2})\s*E(\d{1,4})(?:v\d+)?\b/iu,
    /\b(?:episode|ep|ova|oad|special|chapter|part|act)\.?\s*#?\s*0*(\d{1,4})(?:v\d+)?\b/iu,
    /第\s*0*(\d{1,4})\s*(?:話|话|集|回)/u,
    /(?:^|\s)-\s*0*(\d{1,4})(?:v\d+)?(?=\s|$|\[|\()/iu,
  ]) {
    const match = source.match(pattern);
    if (!match) continue;
    const episode = Number(match[2] || match[1]);
    if (episode >= 1 && episode <= 2_000) return episode;
  }
  const trailing = source.match(/\s+0*(\d{1,3})(?:v\d+)?\s*(?:\[[^\]]+\]|\([^)]*\))*\s*$/iu);
  if (trailing) {
    const episode = Number(trailing[1]);
    if (episode >= 1 && episode <= 500 && !/^(?:19|20)\d{2}$/.test(trailing[1])) return episode;
  }
  return null;
}

function extractBatchRange(value) {
  const source = removeLeadingReleaseBlocks(value);
  const range = source.match(/(?:^|\D)(?:E|EP|Episode)?\s*0*(\d{1,3})\s*(?:-|~|to|a|\.\.)\s*(?:E|EP|Episode)?\s*0*(\d{1,3})(?:\D|$)/iu);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    if (start >= 1 && end > start && end - start <= 500) return Object.freeze({ start, end });
  }
  const all = source.match(/全\s*(\d{1,3})\s*(?:話|话|集)/u);
  if (all && Number(all[1]) >= 1) return Object.freeze({ start: 1, end: Number(all[1]) });
  return null;
}

function detectResolution(value) {
  const source = cleanText(value).toLocaleLowerCase('en-US');
  if (/\b(?:8k|4320p)\b/.test(source)) return '4320p';
  if (/\b(?:4k|uhd|2160p)\b/.test(source)) return '2160p';
  for (const height of [1440, 1080, 720, 576, 540, 480, 360]) {
    if (new RegExp(`(?:^|[^0-9])${height}p?(?:[^0-9]|$)`, 'i').test(source)) return `${height}p`;
  }
  return '';
}

function classifyRelease(value) {
  const source = cleanText(value, 1_000);
  const uncensored = UNCENSORED_RE.test(source);
  const censored = !uncensored && CENSORED_RE.test(source);
  const englishSubtitles = ENGLISH_SUB_RE.test(source);
  const chineseSubtitles = CHINESE_SUB_RE.test(source);
  const batchRange = extractBatchRange(source);
  const complete = COMPLETE_RE.test(source) || Boolean(batchRange);
  const resolution = detectResolution(source);
  const tags = [
    uncensored ? 'Uncensored' : '',
    censored ? 'Censored' : '',
    englishSubtitles ? 'English Subtitles' : '',
    chineseSubtitles ? 'Chinese Subtitles' : '',
    complete ? 'Complete Series' : '',
    resolution,
  ].filter(Boolean);
  return Object.freeze({
    uncensored,
    censored,
    englishSubtitles,
    chineseSubtitles,
    complete,
    batchRange,
    resolution,
    episode: extractEpisodeNumber(source),
    tags: Object.freeze(tags),
  });
}

function selectEpisodeFile(files = [], requestedEpisode = 1, options = {}) {
  const episode = Math.max(Number.parseInt(String(requestedEpisode || 1), 10) || 1, 1);
  const videos = (Array.isArray(files) ? files : [])
    .filter(file => VIDEO_EXTENSION_RE.test(String(file?.path || file?.name || '')))
    .filter(file => !Number(file?.length || file?.size || 0) || Number(file?.length || file?.size || 0) >= 8 * 1024 * 1024)
    .map(file => ({
      ...file,
      path: cleanText(file?.path || file?.name, 1_000),
      length: Math.max(Number(file?.length || file?.size || 0), 0),
      parsedEpisode: extractEpisodeNumber(file?.path || file?.name),
    }));
  if (!videos.length) return null;
  const exact = videos
    .filter(file => file.parsedEpisode === episode)
    .sort((left, right) => right.length - left.length)[0];
  if (exact) return Object.freeze(exact);
  if (videos.length === 1 && (episode === 1 || Number(options.releaseEpisode || 0) === episode)) {
    return Object.freeze(videos[0]);
  }
  const range = options.batchRange;
  if (range && episode >= Number(range.start) && episode <= Number(range.end)) {
    const ordered = [...videos].sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
    const offset = episode - Number(range.start);
    if (ordered[offset]) return Object.freeze(ordered[offset]);
  }
  return null;
}

module.exports = {
  VIDEO_EXTENSION_RE,
  bestMetadataMatch,
  classifyRelease,
  cleanReleaseTitle,
  cleanText,
  detectResolution,
  extractBatchRange,
  extractEpisodeNumber,
  metadataAliases,
  normalizedTitle,
  selectEpisodeFile,
  stripMarkup,
  titleSimilarity,
  titleTokens,
};
