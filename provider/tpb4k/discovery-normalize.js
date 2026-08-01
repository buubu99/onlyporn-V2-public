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
  const rawHash = text(item.infoHash || item.hash);
  const infoHash = /^[a-f0-9]{40}$/i.test(rawHash) ? rawHash.toLowerCase() : '';
  const magnetLink = /^magnet:\?/i.test(text(item.magnet || item.magnetLink))
    ? text(item.magnet || item.magnetLink)
    : '';
  return Object.freeze({
    sourceId: stableId(source, item, index),
    title,
    poster: safeHttps(item.poster || item.image || item.thumbnail),
    background: safeHttps(item.background || item.fanart || item.banner || item.poster || item.image),
    description: text(item.description || item.overview || item.summary),
    studio: text(item.studio?.name || item.studio || item.network),
    performers: names(item.performers || item.cast || item.models),
    tags: names(item.tags || item.categories || item.labels),
    contentTags: names(item.contentTags || item.tags || item.categories || item.labels),
    contentClassificationKnown: Boolean((item.tags || item.categories || item.labels)?.length),
    releaseDate: text(item.releaseDate || item.release_date || item.date || item.published),
    sceneCode: text(item.sceneCode || item.scene_code || item.code),
    duration: Number.parseInt(String(item.duration ?? 0), 10) || 0,
    seeders: Number.parseInt(String(item.seeders ?? 0), 10) || 0,
    size: item.size || 0,
    detailUrl: [item.detailUrl, item.url, item.link].map(safeHttps).find(Boolean) || '',
    torrentUrl: [item.torrentUrl, item.downloadUrl, item.link]
      .map(safeHttps)
      .find(value => /\.torrent(?:$|\?)/i.test(value)) || '',
    upstreamId: text(item.upstreamId || item.id || item.guid),
    infoHash,
    magnetLink,
    trackers: Array.isArray(item.trackers) ? item.trackers.map(text).filter(Boolean) : [],
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

function tagAttribute(block, name, attribute) {
  const escaped = name.replace(':', '\\:');
  const match = String(block).match(new RegExp(`<${escaped}\\b[^>]*\\b${attribute}=[\"']([^\"']+)[\"'][^>]*>`, 'i'));
  return decodeXml(match?.[1] || '');
}

function firstHttpsImage(value) {
  const html = String(value || '');
  const candidates = [];
  for (const pattern of [
    /<img\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /https:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp)(?:\?[^\s"'<>]*)?/gi,
  ]) {
    for (const match of html.matchAll(pattern)) candidates.push(match[1] || match[0]);
  }
  return candidates.map(safeHttps).find(Boolean) || '';
}

function repeatedTags(block, name) {
  const escaped = name.replace(':', '\\:');
  return [...String(block).matchAll(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi'))]
    .map(match => decodeXml(match[1]))
    .filter(Boolean);
}

function parseRssFeed(payload) {
  const xml = String(payload || '');
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];
  return blocks.map((block, index) => {
    const description = tag(block, 'description');
    const infoHash = tag(block, 'nyaa:infoHash') || tag(block, 'infoHash');
    const link = tag(block, 'link');
    const poster = [
      tagAttribute(block, 'media:thumbnail', 'url'),
      tagAttribute(block, 'media:content', 'url'),
      tagAttribute(block, 'enclosure', 'url'),
      firstHttpsImage(description),
    ].map(safeHttps).find(Boolean) || '';
    return {
      id: tag(block, 'guid') || tag(block, 'link'),
      guid: tag(block, 'guid'),
      title: tag(block, 'title'),
      description,
      poster,
      background: poster,
      published: tag(block, 'pubDate'),
      link,
      detailUrl: tag(block, 'guid') || link,
      seeders: tag(block, 'nyaa:seeders'),
      size: tag(block, 'nyaa:size'),
      ...(infoHash ? { infoHash } : {}),
      ...(/^magnet:\?/i.test(link) ? { magnetLink: link } : {}),
      tags: repeatedTags(block, 'category'),
      index,
    };
  });
}

module.exports = {
  decodeXml,
  normalizeFeedItem,
  parseJsonFeed,
  firstHttpsImage,
  parseRssFeed,
  safeHttps,
  stableId,
};
