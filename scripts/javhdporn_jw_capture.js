#!/usr/bin/env node

'use strict';

const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const jqueryFactory = require('jquery');

const MAX_INPUT_BYTES = 3 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_HTML_BYTES = 1024 * 1024;
const WAIT_MS = 2500;

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

  if (Array.isArray(config?.sources)) config.sources.forEach(source => add(source));
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
  let executionWarning = '';

  // Keep the same minimal browser shape that captured the live player on Render.
  window.console = console;
  window.gtag = () => {};
  window.open = () => null;
  window.fetch = global.fetch;
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.matchMedia = () => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
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
  window.TextEncoder = global.TextEncoder;
  window.TextDecoder = global.TextDecoder;

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
    getState() { return 'idle'; },
    getPosition() { return 0; },
    getPlaylist() { return []; },
  };

  playerProxy = new Proxy(playerMethods, {
    get(target, property) {
      if (property in target) return target[property];
      return () => playerProxy;
    },
  });

  function jwplayer() {
    return playerProxy;
  }
  jwplayer.key = '';
  window.jwplayer = jwplayer;
  context.console = console;
  context.jwplayer = jwplayer;
  context.$ = jquery;
  context.jQuery = jquery;
  context.gtag = window.gtag;

  try {
    new vm.Script(script, { filename: 'javhdporn-main.js' }).runInContext(context, {
      timeout: 15_000,
    });
  } catch (error) {
    executionWarning = String(error?.stack || error?.message || error);
  }

  try {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
    window.dispatchEvent(new window.Event('load'));
  } catch (error) {
    if (!executionWarning) executionWarning = String(error?.stack || error?.message || error);
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
    throw new Error(executionWarning || 'JWPlayer setup was not captured');
  }

  send({
    ok: true,
    keys,
    sources,
    executionWarning,
  });
}

main().catch(error => {
  send({ ok: false, error: String(error?.stack || error?.message || error) }, 1);
});
