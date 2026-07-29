'use strict';

const crypto = require('node:crypto');

function decodeEntities(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function cleanText(value) {
  return decodeEntities(String(value || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function attribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function firstTag(block, tagName, predicate = () => true) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  for (const match of String(block || '').matchAll(regex)) {
    if (predicate(match[0])) return match[0];
  }
  return '';
}

function firstContent(block, tagNames = ['h1', 'h2', 'h3', 'strong']) {
  for (const tagName of tagNames) {
    const match = String(block || '').match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    const value = cleanText(match?.[1]);
    if (value) return value;
  }
  return '';
}

function absoluteHttps(base, value) {
  const text = decodeEntities(value).trim();
  if (!text || /^(?:data|javascript|blob):/i.test(text)) return '';
  try {
    const url = new URL(text, base);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function sameOriginPath(base, value, allowedPrefixes = []) {
  const absolute = absoluteHttps(base, value);
  if (!absolute) return '';
  const url = new URL(absolute);
  if (url.origin !== new URL(base).origin) return '';
  if (allowedPrefixes.length && !allowedPrefixes.some(prefix => url.pathname.startsWith(prefix))) return '';
  return `${url.pathname}${url.search}`;
}

function imageUrl(base, block) {
  const source = String(block || '');
  for (const match of source.matchAll(/<img\b[^>]*>/gi)) {
    const img = match[0];
    for (const key of ['data-src', 'data-original', 'data-lazy-src', 'data-thumb_url', 'data-preview', 'src']) {
      const result = absoluteHttps(base, attribute(img, key));
      if (result) return result;
    }
    const srcset = attribute(img, 'srcset');
    if (srcset) {
      const last = srcset.split(',').map(item => item.trim().split(/\s+/)[0]).filter(Boolean).at(-1);
      const result = absoluteHttps(base, last);
      if (result) return result;
    }
  }
  for (const match of source.matchAll(/<[^>]+>/gi)) {
    const tag = match[0];
    for (const key of ['data-bg', 'data-background']) {
      const result = absoluteHttps(base, attribute(tag, key));
      if (result) return result;
    }
    const style = attribute(tag, 'style');
    const background = style.match(/background(?:-image)?\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i)?.[1];
    const result = absoluteHttps(base, background);
    if (result) return result;
  }
  return '';
}

function metaContent(html, property) {
  const regex = /<meta\b[^>]*>/gi;
  for (const match of String(html || '').matchAll(regex)) {
    const tag = match[0];
    const key = attribute(tag, 'property') || attribute(tag, 'name');
    if (key.toLowerCase() === String(property).toLowerCase()) return cleanText(attribute(tag, 'content'));
  }
  return '';
}

function anchorRecords(block) {
  const records = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(block || '').matchAll(regex)) {
    records.push({
      tag: match[0],
      href: attribute(match[0], 'href'),
      title: attribute(match[0], 'title'),
      rel: attribute(match[0], 'rel'),
      className: attribute(match[0], 'class'),
      text: cleanText(match[2]),
    });
  }
  return records;
}

function blocksByStart(html, startPattern, { maxBlockBytes = 180_000 } = {}) {
  const source = String(html || '');
  const regex = new RegExp(startPattern.source, startPattern.flags.includes('g') ? startPattern.flags : `${startPattern.flags}g`);
  const starts = [...source.matchAll(regex)].map(match => match.index).filter(Number.isInteger);
  return starts.map((start, index) => source.slice(start, Math.min(starts[index + 1] ?? source.length, start + maxBlockBytes)));
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseDurationSeconds(value) {
  const text = cleanText(value);
  const clock = text.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
  if (clock) {
    const parts = clock.slice(1).filter(value => value !== undefined).map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*h(?:ours?)?/i)?.[1] || 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?/i)?.[1] || 0);
  return Math.round(hours * 3600 + minutes * 60);
}

function stablePathId(source, path) {
  return `${source}:${Buffer.from(String(path || ''), 'utf8').toString('base64url')}`;
}

function decodeStablePathId(source, id) {
  const prefix = `${source}:`;
  if (!String(id || '').startsWith(prefix)) return '';
  try {
    const path = Buffer.from(String(id).slice(prefix.length), 'base64url').toString('utf8');
    return path.startsWith('/') && !path.startsWith('//') ? path : '';
  } catch {
    return '';
  }
}

function fallbackId(source, title, index = 0) {
  return `${source}:${crypto.createHash('sha256').update(`${title}|${index}`).digest('hex').slice(0, 24)}`;
}

module.exports = {
  absoluteHttps,
  anchorRecords,
  attribute,
  blocksByStart,
  cleanText,
  decodeStablePathId,
  fallbackId,
  firstContent,
  firstTag,
  imageUrl,
  metaContent,
  parseDurationSeconds,
  sameOriginPath,
  stablePathId,
  uniqueBy,
};
