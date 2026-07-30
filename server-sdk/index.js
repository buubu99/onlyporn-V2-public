const express = require('express');
const fs = require('fs');
const path = require('path');
const open = require('opn');
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate');
const getRouter = require('stremio-addon-sdk/src/getRouter');
const { addonEnabled } = require('../catalog');
const mediaRelay = require('../media-relay');

function serveHTTP(addonInterface, opts = {}) {
    if (addonInterface.constructor.name !== 'AddonInterface') {
        throw new Error('first argument must be an instance of AddonInterface');
    }

    const app = express();
    app.set('trust proxy', true);
    const router = getRouter(addonInterface);

    app.use((req, _res, next) => {
        const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const protocol = forwardedProto || req.protocol || 'http';
        const host = req.get('host');
        if (host) mediaRelay.setPublicBase(`${protocol}://${host}`);
        next();
    });

    app.all('/media/:token/:filename?', mediaRelay.handleRequest);

    app.use('/:resource/:type/:id/:extra?.json', (req, res, next) => {
        const { resource, type, id } = req.params;

        if (opts.cache) {
            res.setHeader('cache-control', 'max-age=' + opts.cache);
        }

        next();
    });

    app.use(router);

    // serve static dir
    if (opts.static) {
        const location = path.join(process.cwd(), opts.static);

        if (!fs.existsSync(location)) {
            throw new Error('directory to serve does not exist');
        }

        app.use(opts.static, express.static(location));
    }

    // landing page
    const landingHTML = landingTemplate(addonInterface.manifest);

    app.get('/', (_, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(landingHTML);
    });

    const server = app.listen(opts.port);

    return new Promise(function(resolve, reject) {

        server.on('listening', function() {

            const url = `http://127.0.0.1:${server.address().port}/manifest.json`;

            console.log('HTTP addon accessible at:', url);

            if (process.argv.includes('--launch')) {

                const base = 'https://staging.strem.io#';
                const installUrl = `${base}?addonOpen=${encodeURIComponent(url)}`;

                open(installUrl);
            }

            if (process.argv.includes('--install')) {
                open(url.replace('http://', 'stremio://'));
            }

            resolve({ url, server });

        });

        server.on('error', reject);
    });
}

module.exports = serveHTTP;
