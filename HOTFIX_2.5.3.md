# OnlyPorn Hotfix 2.5.3

OnlyPorn 2.5.2 passed the offline release suite but failed both live production gates.

## SpankBang regression correction

Version 2.5.2 kept SpankBang inside the multi-provider Safari transport introduced for JAV HD Porn. Production still returned HTTP 403 for `/trending_videos/`.

Version 2.5.3 restores the exact isolated Phase 4 transport architecture from v2.4.2:

- dedicated `scripts/safari_fetch_helper.py` process;
- one persistent Safari `curl_cffi` session only for SpankBang;
- the original age-verification cookies;
- the original homepage bootstrap and Referer sequence;
- no JAV HD Porn profile, cookies, methods, or dynamic hosts in that process.

JAV HD Porn now runs in its own `javhdporn_safari_fetch_helper.py` process and cannot affect SpankBang state.

## JAV HD Porn live decoder correction

The v2.5.2 JWPlayer sandbox used substitute `fetch`, `XMLHttpRequest`, `WebSocket`, and other browser objects. The real production `main.js` rejected that environment with `TypeError: Object(...) is not a function`.

Version 2.5.3 uses the minimal JSDOM environment that successfully captured the real JWPlayer configuration in the Render shell:

- native JSDOM `XMLHttpRequest` and browser objects remain intact;
- Node's callable `global.fetch` is exposed as `window.fetch`;
- incompatible network stubs are removed;
- only `jwplayer().setup(config)` is intercepted;
- the existing HLS playlist relay and PNG-wrapper MPEG-TS decoder remain unchanged.

## Release rule

Offline tests are necessary but not sufficient. The release is complete only after Render logs prove:

- SpankBang catalog request returns HTTP 200 and `metasSize > 0`;
- JAV HD Porn logs `encrypted JWPlayer configuration decoded` with `jwSources > 0`;
- the Stremio stream endpoint returns at least one relay URL;
- a relayed wrapped segment is returned as `video/mp2t`.
