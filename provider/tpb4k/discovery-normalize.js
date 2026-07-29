'use strict';

const crypto = require('node:crypto');

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  return text(String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'"));
}

function safeHttps(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : '';
  } catch {
    return '';
  }
}

function names(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(item => text(item?.name || item)).filter(Boolean))];
  }
  return [...new Set(text(value).split(/[,|]/).map(text).filter(Boolean))];
}

function stableId(source, item, index = 0) {
  const direct = text(item.sourceId || item.id || item.guid || item.slug || item.code);
  if (direct) return direct.slice(0, 240);
  const identity = [source, item.title || item.name, item.releaseDate || item.date, item.studio, index]
    .map(text)
    .join('|');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function normalizeFeedItem(source, item = {}, index = 0) {
  const title = text(item.title || item.name);
  if (!title) return null;
  return Object.freeze({
    sourceId: stableId(source, item, index),
    title,
    poster: safeHttps(item.poster || item.image || item.thumbnail),
    background: safeHttps(item.background || item.fanart || item.banner || item.poster || item.image),
    description: text(item.description || item.overview || item.summary),
    studio: text(item.studio?.name || item.studio || item.network),
    performers: names(item.performers || item.cast || item.models),
    releaseDate: text(item.releaseDate || item.release_date || item.date || item.published),
    sceneCode: text(item.sceneCode || item.scene_code || item.code),
    duration: Number.parseInt(String(item.duration ?? 0), 10) || 0,
    seeders: Number.parseInt(String(item.seeders ?? 0), 10) || 0,
    size: item.size || 0,
    detailUrl: safeHttps(item.detailUrl || item.url || item.link),
    upstreamId: text(item.upstreamId || item.id || item.guid),
  });
}

function findArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['metas', 'items', 'results', 'scenes', 'data']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function parseJsonFeed(payload) {
  try {
    return findArray(JSON.parse(String(payload || '')));
  } catch {
    return [];
  }
}

function tag(block, name) {
  const escaped = name.replace(':', '\\:');
  const match = String(block).match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function parseRssFeed(payload) {
  const xml = String(payload || '');
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block, index) => ({
    id: tag(block, 'guid') || tag(block, 'link'),
    guid: tag(block, 'guid'),
    title: tag(block, 'title'),
    description: tag(block, 'description'),
    published: tag(block, 'pubDate'),
    link: tag(block, 'link'),
    seeders: tag(block, 'nyaa:seeders'),
    size: tag(block, 'nyaa:size'),
    index,
  }));
}

module.exports = {
  decodeXml,
  normalizeFeedItem,
  parseJsonFeed,
  parseRssFeed,
  safeHttps,
  stableId,
};
