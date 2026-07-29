const { addonBuilder } = require('stremio-addon-sdk');
const { loadProvider } = require('./provider');
const packageInfo = require('./package.json');
const { catalogs } = require('./catalog');
const logger = require('./logger');

const manifest = {
  id: 'org.masterchief.onlyporn',
  version: packageInfo.version,

  name: 'OnlyPorn',
  description: packageInfo.description,

  icon: 'https://raw.githubusercontent.com/Mast3rCh1ef/addon-asset/main/op.png',
  background:
    'https://cdni.pornpics.com/1280/5/188/87261714/87261714_013_3f11.jpg',

  resources: ['catalog', 'stream', 'meta'],
  types: ['movie'],
  catalogs,

  behaviorHints: {
    adult: true,
  },
};

const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8');

if (manifestBytes >= 8192) {
  throw new Error(`OnlyPorn manifest is ${manifestBytes} bytes; it must remain below 8192 bytes`);
}

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(args =>
  loadProvider(args.id)
    .handleCatalog(args)
    .catch(error => {
      logger.error({ error: error.message, catalogId: args.id }, 'Catalog handler failed');
      return { metas: [] };
    })
);

builder.defineStreamHandler(args =>
  loadProvider(args.id)
    .handleStream(args)
    .catch(error => {
      logger.error({ error: error.message, contentId: args.id }, 'Stream handler failed');
      return { streams: [] };
    })
);

builder.defineMetaHandler(args =>
  loadProvider(args.id)
    .handleMeta(args)
    .catch(error => {
      logger.error({ error: error.message, contentId: args.id }, 'Metadata handler failed');
      return { meta: {} };
    })
);

logger.info({ version: manifest.version, catalogs: manifest.catalogs.length, manifestBytes }, 'OnlyPorn manifest loaded');

module.exports = builder.getInterface();
