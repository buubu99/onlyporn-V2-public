const dns = require('node:dns').promises;
const net = require('node:net');

const RESOURCE_PREFIX = 'onlyporn';
const DNS_CACHE_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE_MAX = 200;
const dnsCache = new Map();

function normalizeHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
}

function normalizeAllowedHosts(hosts = []) {
  return new Set([...hosts].map(normalizeHostname).filter(Boolean));
}

function encodeResourceId(providerName, url) {
  const payload = Buffer.from(String(url), 'utf8').toString('base64url');
  return `${RESOURCE_PREFIX}:${providerName}:${payload}`;
}

function decodeResourceId(id, providerName) {
  const prefix = `${RESOURCE_PREFIX}:${providerName}:`;
  if (!String(id).startsWith(prefix)) return null;

  const payload = String(id).slice(prefix.length);
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error('Malformed OnlyPorn resource ID');
  }

  try {
    return Buffer.from(payload, 'base64url').toString('utf8');
  } catch {
    throw new Error('Malformed OnlyPorn resource ID');
  }
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0];

  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  ) {
    return true;
  }

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mappedIpv4 ? isPrivateIpv4(mappedIpv4[1]) : false;
}

function isPrivateIp(address) {
  const version = net.isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return true;
}

function getCachedDns(hostname) {
  const entry = dnsCache.get(hostname);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    dnsCache.delete(hostname);
    return null;
  }
  return entry.addresses;
}

function setCachedDns(hostname, addresses) {
  if (dnsCache.has(hostname)) dnsCache.delete(hostname);
  dnsCache.set(hostname, {
    addresses,
    expiresAt: Date.now() + DNS_CACHE_TTL_MS,
  });

  while (dnsCache.size > DNS_CACHE_MAX) {
    dnsCache.delete(dnsCache.keys().next().value);
  }
}

async function assertPublicDns(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private or reserved IP addresses are not allowed');
    return;
  }

  const cached = getCachedDns(hostname);
  const addresses = cached || (await dns.lookup(hostname, { all: true, verbatim: true }));

  if (!addresses.length) throw new Error('Hostname did not resolve');
  if (addresses.some(record => isPrivateIp(record.address))) {
    throw new Error('Hostname resolves to a private or reserved IP address');
  }

  if (!cached) setCachedDns(hostname, addresses);
}

function parseHttpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed');
  if (parsed.username || parsed.password) throw new Error('Credentials in URLs are not allowed');
  if (parsed.port && parsed.port !== '443') throw new Error('Only the standard HTTPS port is allowed');

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Local hostnames are not allowed');
  }

  parsed.hostname = hostname;
  parsed.hash = '';
  return parsed;
}

async function assertSafeHttpsUrl(value, { allowedHosts, checkDns = true } = {}) {
  const parsed = parseHttpsUrl(value);
  const hostname = normalizeHostname(parsed.hostname);

  if (allowedHosts) {
    const normalizedAllowedHosts = allowedHosts instanceof Set
      ? allowedHosts
      : normalizeAllowedHosts(allowedHosts);

    if (!normalizedAllowedHosts.has(hostname)) {
      throw new Error(`Host is not approved for this provider: ${hostname}`);
    }
  }

  if (checkDns) await assertPublicDns(hostname);
  return parsed.toString();
}

function sanitizeUrlForLogs(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

module.exports = {
  assertSafeHttpsUrl,
  decodeResourceId,
  encodeResourceId,
  isPrivateIp,
  normalizeAllowedHosts,
  parseHttpsUrl,
  sanitizeUrlForLogs,
};
