function rc4(data, key) {
  const state = Array.from({ length: 256 }, (_, index) => index);
  const keyBytes = Buffer.from(String(key), 'latin1');
  if (!keyBytes.length) throw new Error('JAVHDPorn player key is empty');

  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + keyBytes[i % keyBytes.length]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
  }

  const output = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < data.length; offset += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    [state[i], state[j]] = [state[j], state[i]];
    const keyByte = state[(state[i] + state[j]) & 0xff];
    output[offset] = data[offset] ^ keyByte;
  }

  return output;
}

function playerSalt(version, encodeForApi) {
  if (!encodeForApi || String(version || '1') === '1') return '_0x58fe15';
  if (String(version) === '2') return 'SyntaxError';
  return 'QxLUF1bgIAdeQX';
}

function playerKey(videoId, version, encodeForApi) {
  const material = `${String(videoId)}${playerSalt(version, encodeForApi)}`;
  return Buffer.from(material, 'utf8').toString('base64').split('').reverse().join('');
}

/**
 * Reproduces the site's player transport decoder.
 *
 * The same operation is used for the page bootstrap token and the encrypted
 * API response. The page bootstrap uses the version-specific API salt, while
 * the API response uses the original response salt.
 */
function dex(videoId, value, encodeForApi = false, version = '1') {
  if (!videoId || typeof value !== 'string' || !value.trim()) return '';

  const cipherBytes = Buffer.from(value.trim(), 'base64');
  const decryptedBase64 = rc4(
    cipherBytes,
    playerKey(videoId, version, encodeForApi)
  ).toString('latin1');

  return Buffer.from(decryptedBase64, 'base64').toString('latin1').trim();
}

module.exports = {
  dex,
  playerKey,
  playerSalt,
  rc4,
};
