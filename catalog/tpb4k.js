'use strict';

const FEATURE_FLAG = 'TPB4K_ENABLED';

const SELECTED_CATALOGS = [
  {
    id: 'tpb4k.pornrips.recent',
    name: 'OnlyPorn: PornRips · Recent',
    source: 'pornrips',
    mode: 'recent',
  },
  {
    id: 'tpb4k.hentai.all',
    name: 'OnlyPorn: Hentai · All',
    source: 'hentai',
    mode: 'all',
  },
  {
    id: 'tpb4k.hentai.new',
    name: 'OnlyPorn: Hentai · New',
    source: 'hentai',
    mode: 'new',
  },
  {
    id: 'tpb4k.hentai.top',
    name: 'OnlyPorn: Hentai · Top Rated',
    source: 'hentai',
    mode: 'top',
  },
  {
    id: 'tpb4k.stripchat.girls',
    name: 'OnlyPorn: Stripchat · Girls',
    source: 'stripchat',
    mode: 'girls',
  },
  {
    id: 'tpb4k.stripchat.couples',
    name: 'OnlyPorn: Stripchat · Couples',
    source: 'stripchat',
    mode: 'couples',
  },
  {
    id: 'tpb4k.tpdb.recent',
    name: 'OnlyPorn: ThePornDB · Recent',
    source: 'tpdb',
    mode: 'recent',
  },
  {
    id: 'tpb4k.yesporn.recent',
    name: 'OnlyPorn: YesPorn · Recent',
    source: 'yesporn',
    mode: 'recent',
  },
  {
    id: 'tpb4k.sukebei.top',
    name: 'OnlyPorn: Sukebei · Top',
    source: 'sukebei',
    mode: 'top',
  },
  {
    id: 'tpb4k.studio.brazzersexxtra.top',
    name: 'OnlyPorn: BrazzersExxtra · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'BrazzersExxtra',
  },
  {
    id: 'tpb4k.studio.cum4k.top',
    name: 'OnlyPorn: Cum4K · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'Cum4K',
  },
  {
    id: 'tpb4k.studio.devilsfilm.top',
    name: 'OnlyPorn: DevilsFilm · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'DevilsFilm',
  },
  {
    id: 'tpb4k.studio.digitalplayground.top',
    name: 'OnlyPorn: DigitalPlayground · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'DigitalPlayground',
  },
  {
    id: 'tpb4k.studio.dorcelclub.top',
    name: 'OnlyPorn: DorcelClub · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'DorcelClub',
  },
  {
    id: 'tpb4k.studio.metart.top',
    name: 'OnlyPorn: MetArt · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'MetArt',
  },
  {
    id: 'tpb4k.studio.metartx.top',
    name: 'OnlyPorn: MetArtX · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'MetArtX',
  },
  {
    id: 'tpb4k.studio.milfty.top',
    name: 'OnlyPorn: Milfty · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'Milfty',
  },
  {
    id: 'tpb4k.studio.milfy.top',
    name: 'OnlyPorn: Milfy · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'Milfy',
  },
  {
    id: 'tpb4k.studio.newsensations.top',
    name: 'OnlyPorn: NewSensations · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'NewSensations',
  },
  {
    id: 'tpb4k.studio.pornmegaload.top',
    name: 'OnlyPorn: PornMegaLoad · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'PornMegaLoad',
  },
  {
    id: 'tpb4k.studio.onlyfans.top',
    name: 'OnlyPorn: OnlyFans · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'OnlyFans',
  },
  {
    id: 'tpb4k.studio.playboyplus.top',
    name: 'OnlyPorn: PlayboyPlus · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'PlayboyPlus',
  },
  {
    id: 'tpb4k.studio.sexmex.top',
    name: 'OnlyPorn: SexMex · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'SexMex',
  },
  {
    id: 'tpb4k.studio.thelifeerotic.top',
    name: 'OnlyPorn: TheLifeErotic · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'TheLifeErotic',
  },
  {
    id: 'tpb4k.studio.vixen.top',
    name: 'OnlyPorn: Vixen · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'Vixen',
  },
  {
    id: 'tpb4k.studio.wowgirls.top',
    name: 'OnlyPorn: WowGirls · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'WowGirls',
  },
  {
    id: 'tpb4k.studio.sexart.top',
    name: 'OnlyPorn: SexArt · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'SexArt',
  },
  {
    id: 'tpb4k.studio.xvideosred.top',
    name: 'OnlyPorn: XVideosRED · Top',
    source: 'studio-metadata',
    lookupSource: 'torrent-index',
    mode: 'studio-top',
    studio: 'XVideosRED',
  },
];

function isTpb4kEnabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(String(env[FEATURE_FLAG] || '').trim());
}

function toManifestCatalog(definition) {
  return Object.freeze({
    id: definition.id,
    type: 'movie',
    name: definition.name,
    posterShape: 'poster',
    extra: [{ name: 'skip' }],
    extraSupported: ['skip'],
  });
}

const tpb4kCatalogs = Object.freeze(SELECTED_CATALOGS.map(toManifestCatalog));
const catalogDefinitions = Object.freeze(
  SELECTED_CATALOGS.map(item => Object.freeze({ ...item }))
);
const catalogById = new Map(catalogDefinitions.map(item => [item.id, item]));

function getCatalogDefinition(id) {
  return catalogById.get(String(id || '')) || null;
}

module.exports = {
  FEATURE_FLAG,
  catalogDefinitions,
  getCatalogDefinition,
  isTpb4kEnabled,
  tpb4kCatalogs,
};
