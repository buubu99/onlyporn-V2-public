'use strict';

const BLOCKED_HOTLINK_HOSTS = Object.freeze([
  /(^|\.)imagetwist\.(?:com|co|net|io)$/i,
  /(^|\.)imgtwist\.(?:com|co|net|io)$/i,
]);
const ERROR_TEXT = /(?:hotlink(?:ing)?\s+(?:is\s+)?disabled|imagetwist\.com\s*error|image\s+(?:was\s+)?(?:not\s+found|removed|deleted|unavailable)|access\s+denied|bandwidth\s+exceeded|forbidden|placeholder|no\s+image)/i;

function blockedHost(value) {
  try {
    const host = new URL(String(value || '')).hostname;
    return BLOCKED_HOTLINK_HOSTS.some(pattern => pattern.test(host));
  } catch { return true; }
}
function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { format: 'jpeg', height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}
function webpDimensions(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buffer.toString('ascii', 12, 16);
  if (kind === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { format: 'webp', width, height };
  }
  if (kind === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
    return { format: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
function avifDimensions(buffer) {
  if (buffer.length < 32 || buffer.toString('ascii', 4, 8) !== 'ftyp') return null;
  const brands = buffer.toString('ascii', 8, Math.min(buffer.length, 40));
  if (!/(?:avif|avis)/.test(brands)) return null;
  for (let offset = 0; offset + 20 <= buffer.length; offset += 1) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'ispe') continue;
    return { format: 'avif', width: buffer.readUInt32BE(offset + 8), height: buffer.readUInt32BE(offset + 12) };
  }
  return { format: 'avif', width: 0, height: 0 };
}
function imageDimensions(buffer) {
  return pngDimensions(buffer) || jpegDimensions(buffer) || webpDimensions(buffer) || avifDimensions(buffer);
}
function errorSignature(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 256 * 1024)).toString('latin1').replace(/[^\x20-\x7e]+/g, ' ');
  return ERROR_TEXT.test(sample);
}
async function readBounded(response, maxBytes) {
  const announced = Number.parseInt(String(response?.headers?.get?.('content-length') || 0), 10) || 0;
  if (announced > maxBytes) throw new Error('Sukebei poster exceeded the configured byte limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Sukebei poster exceeded the configured byte limit');
  return buffer;
}
async function validateImageResponse(response, options = {}) {
  const url = String(options.url || '');
  if (blockedHost(url)) return Object.freeze({ valid: false, reason: 'blocked-hotlink-host', width: 0, height: 0, bytes: 0 });
  const maxBytes = Math.max(Number(options.maxResponseBytes || 2_000_000), 32_768);
  let buffer;
  try { buffer = await readBounded(response, maxBytes); }
  catch (error) { return Object.freeze({ valid: false, reason: String(error?.message || 'image-read-failed'), width: 0, height: 0, bytes: 0 }); }
  if (buffer.length < 8_192) return Object.freeze({ valid: false, reason: 'image-too-small', width: 0, height: 0, bytes: buffer.length });
  if (errorSignature(buffer)) return Object.freeze({ valid: false, reason: 'image-error-signature', width: 0, height: 0, bytes: buffer.length });
  const dimensions = imageDimensions(buffer);
  if (!dimensions) return Object.freeze({ valid: false, reason: 'invalid-image-signature', width: 0, height: 0, bytes: buffer.length });
  if (dimensions.width && dimensions.height && (dimensions.width < 320 || dimensions.height < 180 || dimensions.width * dimensions.height < 120_000)) {
    return Object.freeze({ valid: false, reason: 'image-dimensions-too-small', width: dimensions.width, height: dimensions.height, bytes: buffer.length });
  }
  return Object.freeze({ valid: true, reason: 'verified-image-bytes', width: dimensions.width, height: dimensions.height, bytes: buffer.length, format: dimensions.format });
}

module.exports = { BLOCKED_HOTLINK_HOSTS, blockedHost, imageDimensions, validateImageResponse };
