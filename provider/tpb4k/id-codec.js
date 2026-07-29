'use strict';

const PREFIX = 'onlyporn:tpb4k:';
const VERSION = 1;
const MAX_SOURCE_ID_LENGTH = 512;

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function encodeTpb4kId({ source, sourceId, catalogId = '' }) {
  const normalizedSource = String(source || '').trim().toLowerCase();
  const normalizedSourceId = String(sourceId || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(normalizedSource)) {
    throw new Error('Invalid TPB4K source');
  }
  if (!normalizedSourceId || normalizedSourceId.length > MAX_SOURCE_ID_LENGTH) {
    throw new Error('Invalid TPB4K source item ID');
  }

  return `${PREFIX}${encodePayload({
    v: VERSION,
    s: normalizedSource,
    i: normalizedSourceId,
    c: String(catalogId || '').trim(),
  })}`;
}

function decodeTpb4kId(value) {
  const text = String(value || '');
  if (!text.startsWith(PREFIX)) return null;
  const payload = decodePayload(text.slice(PREFIX.length));
  if (!payload || payload.v !== VERSION) return null;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(payload.s || ''))) return null;
  if (!payload.i || String(payload.i).length > MAX_SOURCE_ID_LENGTH) return null;
  return Object.freeze({
    version: VERSION,
    source: String(payload.s),
    sourceId: String(payload.i),
    catalogId: String(payload.c || ''),
  });
}

module.exports = {
  PREFIX,
  decodeTpb4kId,
  encodeTpb4kId,
};
