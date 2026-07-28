#!/usr/bin/env node

'use strict';

const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const jqueryFactory = require('jquery');

const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const WAIT_MS = 1500;

function send(payload, status = 0) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = status;
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

function collectSources(config) {
  const output = [];
  const seen = new Set();

  function add(value, context = {}) {
    let url = '';
    let type = '';
    let label = '';

    if (typeof value === 'string') {
      url = value;
    } else if (value && typeof value === 'object') {
      url = safeString(value.file || value.src || value.url);
      type = safeString(value.type);
      label = safeString(value.label || value.name || value.resolution);
    }

    if (!url || !/^https?:\/\//i.test(url)) return;
    if (!/\.m3u8(?:$|[?#])/i.test(url) && !/\.mp4(?:$|[?#])/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    output.push({
      url,
      type: type || (/\.m3u8(?:$|[?#])/i.test(url) ? 'hls' : 'mp4'),
      label: label || safeString(context.label),
    });
  }

  if (Array.isArray(config?.sources)) {
    config.sources.forEach(source => add(source));
  }
  if (typeof config?.file === 'string') add(config.file);

  const playlist = Array.isArray(config?.playlist) ? config.playlist : [];
  playlist.forEach(item => {
    if (Array.isArray(item?.sources)) {
      item.sources.forEach(source => add(source, { label: item?.title }));
    }
    if (item?.file) add(item.file, { label: item?.title });
  });

  return output;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_INPUT_BYTES) {
      throw new Error('JAVHDPorn decoder input exceeded the size limit');
    }
  }

  const input = JSON.parse(raw || '{}');
  const html = safeString(input.html);
  const script = safeString(input.script);
  const playerUrl = safeString(input.playerUrl);

  if (!html || Buffer.byteLength(html) > MAX_HTML_BYTES) {
    throw new Error('JAVHDPorn player HTML is missing or too large');
  }
  if (!script || Buffer.byteLength(script) > MAX_SCRIPT_BYTES) {
    throw new Error('JAVHDPorn player JavaScript is missing or too large');
  }
  if (!/^https:\/\/video\d*\.javhdporn\.net\//i.test(playerUrl)) {
    throw new Error('JAVHDPorn player URL is not approved');
  }

  const dom = new JSDOM(html, {
    url: playerUrl,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  let capturedConfig = null;
  let executionError = '';

  const quietConsole = {
    log() {},
    info() {},
    warn() {},
    error() {},
    debug() {},
    clear() {},
    trace() {},
  };

  window.console = quietConsole;
  window.gtag = () => {};
  window.ga = () => {};
  window.open = () => null;
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => null;
  window.focus = () => {};
  window.blur = () => {};
  window.scrollTo = () => {};
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.fetch = async () => ({
    ok: false,
    status: 403,
    headers: new Map(),
    text: async () => '',
    json: async () => ({}),
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  window.XMLHttpRequest = class DisabledXMLHttpRequest {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.responseText = '';
      this.onreadystatechange = null;
      this.onload = null;
      this.onerror = null;
    }
    open() { this.readyState = 1; }
    setRequestHeader() {}
    addEventListener() {}
    removeEventListener() {}
    getAllResponseHeaders() { return ''; }
    getResponseHeader() { return null; }
    abort() {}
    send() {
      this.readyState = 4;
      window.setTimeout(() => {
        this.onreadystatechange?.();
        this.onerror?.(new window.Event('error'));
      }, 0);
    }
  };
  window.WebSocket = class DisabledWebSocket {
    constructor() { this.readyState = 3; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
    send() {}
  };
  window.EventSource = class DisabledEventSource {
    constructor() { this.readyState = 2; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
  try {
    window.navigator.sendBeacon = () => false;
  } catch {
    // Best-effort network isolation.
  }
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.IntersectionObserver = class IntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.requestAnimationFrame = callback => window.setTimeout(() => callback(Date.now()), 0);
  window.cancelAnimationFrame = id => window.clearTimeout(id);
  window.TextEncoder = global.TextEncoder;
  window.TextDecoder = global.TextDecoder;
  window.chrome = { app: {}, runtime: {} };
  if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:onlyporn';
  if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};

  try {
    Object.defineProperty(window.navigator, 'webdriver', {
      configurable: true,
      get: () => false,
    });
  } catch {
    // Best-effort browser compatibility shim.
  }

  try {
    window.parent.postMessage = () => {};
  } catch {
    // The parent object may be read-only under some jsdom versions.
  }

  const jquery = jqueryFactory(window);
  window.$ = jquery;
  window.jQuery = jquery;

  let playerProxy;
  const playerMethods = {
    setup(config) {
      capturedConfig = config;
      return playerProxy;
    },
    on() { return playerProxy; },
    once() { return playerProxy; },
    off() { return playerProxy; },
    addButton() { return playerProxy; },
    removeButton() { return playerProxy; },
    setConfig() { return playerProxy; },
    setVolume() { return playerProxy; },
    setMute() { return playerProxy; },
    setFullscreen() { return playerProxy; },
    play() { return playerProxy; },
    pause() { return playerProxy; },
    stop() { return playerProxy; },
    getState() { return 'idle'; },
    getPosition() { return 0; },
    getDuration() { return 0; },
    getVolume() { return 100; },
    getMute() { return false; },
    getFullscreen() { return false; },
    getPlaylistItem() { return null; },
    getPlaylist() { return []; },
    getConfig() { return capturedConfig || {}; },
  };

  playerProxy = new Proxy(playerMethods, {
    get(target, property) {
      if (property in target) return target[property];
      if (property === Symbol.toStringTag) return 'JWPlayer';
      return () => playerProxy;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  });

  function jwplayer() {
    return playerProxy;
  }
  jwplayer.key = '';
  jwplayer.version = '8.23.2';

  window.jwplayer = jwplayer;
  context.console = quietConsole;
  context.process = undefined;
  context.require = undefined;
  context.module = undefined;
  context.exports = undefined;
  context.global = undefined;
  context.jwplayer = jwplayer;
  context.$ = jquery;
  context.jQuery = jquery;
  context.gtag = window.gtag;

  try {
    new vm.Script(script, { filename: 'javhdporn-main.js' }).runInContext(context, {
      timeout: 10_000,
    });
  } catch (error) {
    executionError = String(error?.message || error);
  }

  try {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', {
      bubbles: true,
      cancelable: true,
    }));
    window.dispatchEvent(new window.Event('load'));
  } catch (error) {
    if (!executionError) executionError = String(error?.message || error);
  }

  const deadline = Date.now() + WAIT_MS;
  while (!capturedConfig && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  const sources = collectSources(capturedConfig);
  const keys = capturedConfig && typeof capturedConfig === 'object'
    ? Object.keys(capturedConfig)
    : [];
  dom.window.close();

  if (!capturedConfig) {
    throw new Error(executionError || 'JWPlayer setup was not captured');
  }

  send({
    ok: true,
    keys,
    sources,
    executionWarning: executionError,
  });
}

main().catch(error => {
  send({ ok: false, error: String(error?.message || error) }, 1);
});
