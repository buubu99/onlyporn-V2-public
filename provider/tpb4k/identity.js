'use strict';

const crypto = require('node:crypto');

const NOISE_PATTERNS = [
  /\b(?:8k|4k|2160p|1440p|1080p|720p|576p|480p|360p)\b/gi,
  /\b(?:uhd|fhd|hdr10\+?|hdr|dolby[ ._-]?vision|dv)\b/gi,
  /\b(?:web[ ._-]?dl|webrip|bluray|bdrip|remux|x26[45]|h\.?26[45]|hevc|av1)\b/gi,
  /\b(?:aac|ac3|eac3|dts(?:-hd)?|atmos)\b/gi,
  /\b(?:rarbg|etrg|eztv|yify)\b/gi,
  /\[[^\]]*\]|\([^)]*\)/g,
];

function normalizeToken(value) {
  let text = String(value || '').normalize('NFKC').toLowerCase();
  for (const pattern of NOISE_PATTERNS) text = text.replace(pattern, ' ');
  return text
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePeople(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(/[,/&]/);
  return [...new Set(list.map(normalizeToken).filter(Boolean))].sort();
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  const match = text.match(/\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (match) {
    const [year, month, day] = match[0].split(/[-/.]/).map(Number);
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return '';
}

function normalizeExplicitSceneCode(value) {
  const text = String(value || '').normalize('NFKC').trim().toUpperCase();
  const match = text.match(/^([A-Z]{2,12})[-_ ]?(\d{2,8})$/);
  return match ? `${match[1]}-${match[2]}` : '';
}

function extractSceneCode(...values) {
  for (const value of values) {
    const text = String(value || '').normalize('NFKC').toUpperCase();
    const match = text.match(/\b([A-Z]{2,12})[-_](\d{2,8})\b/);
    if (match) return `${match[1]}-${match[2]}`;
  }
  return '';
}

function buildSceneIdentity(input = {}) {
  const studio = normalizeToken(input.studio);
  const title = normalizeToken(input.title || input.name);
  const performers = normalizePeople(input.performers);
  const releaseDate = normalizeDate(input.releaseDate || input.date);
  // Provider scene-code/SKU fields are authoritative and may use a space.
  // Free-form titles require an explicit hyphen/underscore, and opaque
  // provider IDs are never interpreted as codes. This prevents phrases such
  // as "with 40-year-old" or UUID fragments from becoming false scene codes.
  const sceneCode =
    normalizeExplicitSceneCode(input.sceneCode) ||
    extractSceneCode(input.title);

  const parts = [studio, title, performers.join(','), releaseDate, sceneCode].filter(Boolean);
  const canonical = parts.join('|');
  const digest = crypto.createHash('sha256').update(canonical || 'unknown').digest('hex').slice(0, 24);

  return Object.freeze({
    canonical,
    digest,
    studio,
    title,
    performers,
    releaseDate,
    sceneCode,
  });
}

module.exports = {
  buildSceneIdentity,
  extractSceneCode,
  normalizeDate,
  normalizePeople,
  normalizeToken,
};
