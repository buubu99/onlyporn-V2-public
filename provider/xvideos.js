const { load } = require('cheerio');    
const logger = require('../logger');    
const { meta } = require('../model');    
const Provider = require('./provider');  
  
const DEFAULT_POSTER =  
  'https://thumb-cdn77.xvideos-cdn.com/default.jpg';  
  
const cleanTitle = (title = '') =>  
  title  
    .replace(/^xvideos\s*video\s*/i, '')  
    .replace(/^xvideos\s*/i, '')  
    .trim();  
  
const normalizeUrl = (url) => {
  if (!url || typeof url !== 'string') return undefined;

  if (!url.includes('xvideos-cdn.com')) return url; // ✅ ADD THIS

if (url.includes('thumb-cdn77')) return url;

  return url
    .replace(/^\/\//, 'https://')
    .replace(/thumbs?-cdn\d+\.xvideos-cdn\.com/, 'thumb-cdn77.xvideos-cdn.com')
    .replace(/thumbs\d*\.xvideos-cdn\.com/, 'thumb-cdn77.xvideos-cdn.com');
};

const resolvePoster = (url) => {
  if (!url) return DEFAULT_POSTER;

  url = normalizeUrl(url);
  if (!url) return DEFAULT_POSTER;

  

  return url;
};

  
  
/* =========================    
   🔥 ADDED CACHE    
========================= */    
const htmlCache = new Map();    
  
const inFlight = new Map(); // ✅ FIX (missing before)    
const HTML_TTL = 1000 * 60 * 5; // 5 min

const metaCache = new Map();
const META_TTL = 1000 * 60 * 5;

const REGEX = {
  videoHLS: /html5player\.setVideoHLS\(['"]([^'"]+)['"]\)/,
  videoHigh: /html5player\.setVideoUrlHigh\(['"]([^'"]+)['"]\)/,
  videoLow: /html5player\.setVideoUrlLow\(['"]([^'"]+)['"]\)/,
  thumb169: /html5player\.setThumbUrl169\(['"]([^'"]+)['"]\)/,
  thumb: /html5player\.setThumbUrl\(['"]([^'"]+)['"]\)/,
  thumbCdn: /(https:\/\/thumb-cdn\d+\.xvideos-cdn\.com\/[^'"]+xv_\d+_p\.avif)/,
  thumbSlide: /(https:\/\/thumb(?:-cdn\d+)?\.xvideos-cdn\.com\/[^'"]+xv_\d+_t\.jpg)/
};    
  
class XvideosProvider extends Provider {    
  
  constructor() {    
    super('https://www.xvideos.com', 'xvideos', 50);    
  }    
  
  static create() {    
    return new XvideosProvider();    
  }    
  
  async fetchHtml(url) {    
  
    const cached = htmlCache.get(url);    
    if (cached && (Date.now() - cached.time < HTML_TTL)) {    
      return cached.data;    
    }    
  
    if (inFlight.has(url)) {    
      return inFlight.get(url);    
    }    
    
  
    const promise = (async () => {    
  try {    
  
  
    const html = await super.fetchHtml(url);    
  
    htmlCache.set(url, { data: html, time: Date.now() });    
if (htmlCache.size > 300) {    
  const firstKey = htmlCache.keys().next().value;    
  htmlCache.delete(firstKey);    
}    
    return html;    
  } finally {    
    inFlight.delete(url);    
  }    
})();    
  
    inFlight.set(url, promise);    
  
    return promise;    
  }    
  
  getInitialUrl() {    
    return this.baseUrl;    
  }    
  
  handleSearch({ extra: { search: keyword } }) {    
    return `${this.baseUrl}/?k=${encodeURIComponent(keyword)}`;    
  }    
  
  handleGenre(args) {    
    return this.handleSearch({ ...args, extra: { search: args.extra.genre } });    
  }    
  
  handlePagination(url, { extra: { skip } }) {
  const page = Math.floor(skip / 48);

  const u = new URL(url);

  // ✅ SEARCH / GENRE (detect via ?k=)
  if (u.searchParams.has('k')) {
    u.searchParams.set('p', page);
    return u.toString();
  }

  // ✅ HOMEPAGE
  if (url === this.baseUrl || url === `${this.baseUrl}/`) {
    return page === 0
      ? this.baseUrl
      : `${this.baseUrl}/new/${page}`;
  }

  // ✅ FALLBACK (safety)
  return `${this.baseUrl}/new/${page}`;
}    
  
   getCatalogMetas(html) {  
  const $ = load(html);  
  const metadatas = [];  
  const seen = new Set();  
  
  $('div.thumb-block a').each((_, el) => {  
    const href = $(el).attr('href');  
    if (!href || !href.startsWith('/video')) return;  
  
    let id = new URL(href, this.baseUrl).href;  
  
id = id  
  .split('?')[0]  
  .replace(/\/THUMBNUM.*/, '')  
  .replace(/\/$/, '');  
  
    if (seen.has(id)) return;  
    seen.add(id); 

const parent = $(el).closest('div.thumb-block');
const img = parent.find('img').first();
const titleAnchor = parent.find('.thumb-under p > a'); 
      
  
    let thumb =
  img.attr('data-thumb_url169') ||
  img.attr('data-thumb_url') ||
  img.attr('data-thumb') ||
  img.attr('data-src') ||
  img.attr('src');



thumb = normalizeUrl(thumb);

if (!thumb) {
  thumb = DEFAULT_POSTER;
} else if (thumb.includes('THUMBNUM')) {

  // Try to extract frame count from any available attribute
  const candidates = [
    img.attr('data-thumb'),
    img.attr('data-src'),
    img.attr('src')
  ].filter(Boolean);

  let resolved = null;

  for (const c of candidates) {
    const match = c.match(/xv_(\d+)_t\.jpg/);
    if (match) {
      resolved = thumb.replace('THUMBNUM', match[1]);
      break;
    }
  }

  // fallback: try to guess from known range (1–30)
  if (!resolved) {
    // pick middle frame (best visual usually)
    resolved = thumb.replace('THUMBNUM', '15');
  }

  thumb = normalizeUrl(resolved);

  if (!thumb) {
    thumb = DEFAULT_POSTER;
  }
}

  
  

let titleRaw =
  $(el).attr('title') ||
  img.attr('alt') ||
  titleAnchor.attr('title') ||
  titleAnchor.text() ||
  'Video';  
  
    metadatas.push(
  new meta.MetaPreview(
    id,
    Provider.TYPE,
    cleanTitle(titleRaw),
    thumb,
    {
      posterShape: 'landscape' // 👈 ADD
    }
  )
);  
  });  
  
  return metadatas;  
}    
  
  async getMetadata(args) {
  const cached = metaCache.get(args.id);
  if (cached && (Date.now() - cached.time < META_TTL)) {
    return cached.data.metaResponse;
  }

  const html = await this.fetchHtml(args.id);
  const parsed = this.parseVideoPage({ id: args.id, html });

  metaCache.set(args.id, {
    data: parsed,
    time: Date.now()
  });

if (metaCache.size > 300) {
  const firstKey = metaCache.keys().next().value;
  metaCache.delete(firstKey);
}

  return parsed.metaResponse;
}    
  
  parseVideoPage({ id, html }) {

const $ = load(html);  
  
    
  
  
  
let jsonContentUrl = null;  
  
try {  
  const json = JSON.parse(  
    $('script[type="application/ld+json"]').first().text()  
  );  
  jsonContentUrl = json?.contentUrl || null;  
} catch (e) {}  
  
const videoMatch =
  html.match(REGEX.videoHLS) ||
  html.match(REGEX.videoHigh) ||
  html.match(REGEX.videoLow);


const videoPageUrl = videoMatch ? videoMatch[1] : null;  
  
const isBroken =
  !videoPageUrl &&
  !jsonContentUrl &&
  !html.includes('html5player');  
  
if (isBroken) {  
  logger.warn('Invalid video page (real failure)');  
  
  return {
  metaResponse: new meta.MetaResponse(
    id,
    Provider.TYPE,
    'Unavailable Video',
    {
      links: [],
      description: '',
      background: null,
      poster: DEFAULT_POSTER,
      posterShape: 'landscape', // 👈 ADD
      genres: []
    }
  ),
  videoPageUrl: null
};  
}  
  
  /* =========================  
     TAGS / LINKS  
  ========================= */  
  const links = [];  
  $('div.video-tags > a').each((i, e) => {  
    const $tag = $(e);  
  
    links.push(  
      new meta.MetaLink(  
        $tag.text(),  
        'Genre',  
        this.baseUrl + $tag.attr('href')  
      )  
    );  
  });    
  
    
  
    
  
  /* =========================  
     META TAGS  
  ========================= */  
  const title = $('meta[property="og:title"]').attr('content');
const description = $('meta[name="description"]').attr('content');
const ogImage = $('meta[property="og:image"]').attr('content');
const keywords = $('meta[name="keywords"]').attr('content');  
  
  const thumbMatch =
  html.match(REGEX.thumb169) ||
  html.match(REGEX.thumbCdn) ||
  html.match(REGEX.thumb);

let background = resolvePoster(
  thumbMatch?.[1] || ogImage
);  
  
  
  let poster = background;
  
  
  /* =========================  
     GENRES  
  ========================= */  
  const genres = keywords
  ? keywords.split(',').map(g => g.trim())
  : [];  
  
  
  /* =========================  
     META RESPONSE  
  ========================= */  
  const metaResponse = new meta.MetaResponse(
  id,
  Provider.TYPE,
  cleanTitle(title || 'Video'),
  {
    links,
    description,
    background,
    poster,
    posterShape: 'landscape', // 👈 ADD
    genres
  }
);  
  
  logger.debug({ videoPageUrl, poster }, 'XVideos FINAL extraction');  
  
  return {  
    metaResponse,  
    videoPageUrl  
  };  
}    
  
  async processStreams({ id }) {

  let cached = metaCache.get(id);
  let metaData;

  if (cached && (Date.now() - cached.time < META_TTL)) {
    metaData = cached.data;
  } else {
    const html = await this.fetchHtml(id);
    metaData = this.parseVideoPage({ id, html });

    metaCache.set(id, {
      data: metaData,
      time: Date.now()
    });
  }

  logger.debug({ videoPageUrl: metaData.videoPageUrl }, 'XVideos stream source');

  let streamsResponse = await super.getStreams(metaData);    
  
    /* =========================    
       🔥 FIX LOW QUALITY ISSUE    
    ========================= */    
    if (streamsResponse?.streams?.length) {    
  
  streamsResponse.streams = streamsResponse.streams.map(s => {    
  
    // ✅ SAFE RESOLUTION FALLBACK    
    const match = s.url?.match(/(\d{3,4})p/);    
const resolution =    
  s.resolution ||    
  (match ? match[1] + 'p' : null) ||    
  'unknown';    
  
    // ✅ SAFE URL BUILD (DO NOT BREAK PATH)    
    let finalUrl = s.url;    
  
if (!s.url.startsWith('http') && metaData.videoPageUrl) {    
  const base = metaData.videoPageUrl.substring(    
    0,    
    metaData.videoPageUrl.lastIndexOf('/') + 1    
  );    
  finalUrl = base + s.url;    
}    
  
    return {    
      ...s,    
      url: finalUrl,    
      name: `XVideos ${resolution}`,    
      quality: resolution    
    };    
  });    
  
  // ✅ SORT PROPERLY    
  streamsResponse.streams.sort((a, b) => {    
    const getNum = (r) => parseInt(r) || 0;    
    return getNum(b.quality) - getNum(a.quality);    
  });    
  
  return streamsResponse;    
}    
  
        
    let streams = [];    
  
    try {    
      const json = JSON.parse(    
        $('script[type="application/ld+json"]').first().text()    
      );    
  
      if (json && json.contentUrl) {    
        streams.push({    
          type: 'movie',    
          url: json.contentUrl,    
          name: 'Onlyporn'    
        });    
      }    
  
    } catch (e) {    
      logger.warn('ld+json parse failed');    
    }    
  
    return { streams };    
  }    
  
  transformStream(url, stream) {    
    return {    
      ...stream,    
      url: url.includes('hls.m3u8')    
        ? url.replace('hls.m3u8', '') + stream.url // ✅ ALWAYS build full URL    
        : url + stream.url    
    };    
  }    
}    
  
module.exports = XvideosProvider.create;