'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  __testOnlyIsCatalogBoundSukebeiTorrent: isCatalogBoundSukebeiTorrent,
  __testOnlyPassesTorrentSeederGate: passesTorrentSeederGate,
} = require('./tpb4k');

// Exact SONE-620 hashes observed in the production failure.
const SONE620_ZERO_SEEDERS = '361c0ffda3dcc759ff50a01b07ce8d36c451dc07';
const SONE620_ONE_SEEDER = '6bc9d842a11a8c654d9efb49d5816a8523762181';
const OTHER_HASH = '0123456789abcdef0123456789abcdef01234567';
const CONFIG = Object.freeze({ minimumSeeders: 3 });

function decoded(hash, source = 'sukebei') {
  return {
    source,
    torrents: [{ infoHash: hash }],
  };
}

function torrent(hash, seeders, source = 'sukebei') {
  return {
    kind: 'p2p',
    source,
    infoHash: hash,
    seeders,
    provenance: [],
  };
}

test('SONE-620 catalog-bound Sukebei hash survives with zero seeders', () => {
  const candidate = torrent(SONE620_ZERO_SEEDERS, 0);
  const identity = decoded(SONE620_ZERO_SEEDERS);

  assert.equal(isCatalogBoundSukebeiTorrent(identity, candidate), true);
  assert.equal(passesTorrentSeederGate(candidate, identity, CONFIG), true);
});

test('SONE-620 catalog-bound Sukebei hash survives with one seeder', () => {
  const candidate = torrent(SONE620_ONE_SEEDER, 1);
  const identity = decoded(SONE620_ONE_SEEDER);

  assert.equal(isCatalogBoundSukebeiTorrent(identity, candidate), true);
  assert.equal(passesTorrentSeederGate(candidate, identity, CONFIG), true);
});

test('Sukebei exception is exact-hash-bound and cannot rescue an unrelated hash', () => {
  assert.equal(
    passesTorrentSeederGate(
      torrent(OTHER_HASH, 0),
      decoded(SONE620_ZERO_SEEDERS),
      CONFIG
    ),
    false
  );
});

test('non-Sukebei torrent sources keep the normal minimum-seeder rule', () => {
  assert.equal(
    passesTorrentSeederGate(
      torrent(SONE620_ZERO_SEEDERS, 0, 'torrent-index'),
      decoded(SONE620_ZERO_SEEDERS, 'torrent-index'),
      CONFIG
    ),
    false
  );

  assert.equal(
    passesTorrentSeederGate(
      torrent(SONE620_ZERO_SEEDERS, 3, 'torrent-index'),
      decoded(SONE620_ZERO_SEEDERS, 'torrent-index'),
      CONFIG
    ),
    true
  );
});
