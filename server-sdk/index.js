const express = require('express');
const fs = require('fs');
const path = require('path');
const open = require('opn');
const landingTemplate = require('stremio-addon-sdk/src/landingTemplate');
const getRouter = require('stremio-addon-sdk/src/getRouter');
const { addonEnabled } = require('../catalog');
const mediaRelay = require('../media-relay');
const logger = require('../logger');

function requestLogLevel(context, status = 200) {
    if (status >= 500) return 'error';
    if (status >= 400) return 'warn';
    return context.resource === 'health' ? 'debug' : 'info';
}

function installRequestTracing(app) {
    app.use((req, res, next) => {
        const context = logger.createRequestContext(req);
        const startedAt = process.hrtime.bigint();

        logger.runWithTraceContext(context, () => {
            const initialLevel = requestLogLevel(context);
            logger[initialLevel](
                {
                    event: 'REQ_IN',
                    method: req.method,
                    hasRange: Boolean(req.headers.range),
                },
                'REQ_IN'
            );

            let completed = false;
            const logOutcome = finished => {
                if (completed) return;
                completed = true;
                const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
                const level = requestLogLevel(context, res.statusCode);
                logger[level](
                    {
                        event: 'REQ_OUT',
                        method: req.method,
                        status: res.statusCode,
                        durationMs: Number(durationMs.toFixed(2)),
                        completed: Boolean(finished),
                        hasRange: Boolean(req.headers.range),
                    },
                    'REQ_OUT'
                );
            };

            res.once('finish', () => logOutcome(true));
            res.once('close', () => logOutcome(res.writableEnded));
            next();
        });
    });
}

function serveHTTP(addonInterface, opts = {}) {
    if (addonInterface.constructor.name !== 'AddonInterface') {
        throw new Error('first argument must be an instance of AddonInterface');
    }

    const app = express();
    app.set('trust proxy', true);
    installRequestTracing(app);
    if (typeof opts.configureApp === 'function') opts.configureApp(app);
    const router = getRouter(addonInterface);

    app.use((req, _res, next) => {
        const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
        const protocol = forwardedProto || req.protocol || 'http';
        const host = req.get('host');
        if (host) mediaRelay.setPublicBase(`${protocol}://${host}`);
        next();
    });

    app.all('/media/:generation(g-[a-f0-9]{7,40})/:token/:filename?', (req, res) => {
        let expectedGeneration = '';
        try {
            expectedGeneration = mediaRelay.mediaGeneration();
        } catch {
            res.status(500).type('text/plain').send('Media generation is misconfigured');
            return;
        }

        if (!expectedGeneration || req.params.generation !== expectedGeneration) {
            res.status(410).type('text/plain').send('Media generation is no longer available');
            return;
        }

        mediaRelay.handleRequest(req, res);
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
