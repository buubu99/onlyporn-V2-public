'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { load } = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_SCRIPT = path.join(ROOT, 'scripts', 'javhdporn_jw_capture.js');
const MAX_OUTPUT_BYTES = 1024 * 1024;

function isJavPlayerHost(hostname) {
  return /^video\d*\.javhdporn\.net$/i.test(String(hostname || '').toLowerCase());
}

function getPlayerConfigMetadata(html, playerUrl) {
  const $ = load(String(html || ''));
  const encryptedConfig = String($('#jwplayer').attr('data-config') || '').trim();
  const scriptSource = $('script[src]')
    .toArray()
    .map(element => String($(element).attr('src') || '').trim())
    .find(value => /(?:^|\/)main\.js(?:[?#]|$)/i.test(value));

  let mainScriptUrl = '';
  try {
    if (scriptSource) mainScriptUrl = new URL(scriptSource, playerUrl).toString();
  } catch {
    mainScriptUrl = '';
  }

  return {
    encryptedConfig,
    mainScriptUrl,
  };
}

function captureJwPlayerSources({ html, script, playerUrl, timeoutMs = 14_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=96', CAPTURE_SCRIPT],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH || '',
          HOME: '/tmp',
          NODE_ENV: 'production',
          NODE_OPTIONS: '',
          TZ: 'UTC',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`JAVHDPorn JWPlayer decoder timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += String(chunk || '');
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('JAVHDPorn JWPlayer decoder output exceeded the size limit'));
      }
    });
    child.stderr.on('data', chunk => {
      stderr = `${stderr}${String(chunk || '')}`.slice(-1000);
    });
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (settled) return;
      let payload;
      try {
        const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '';
        payload = JSON.parse(line);
      } catch {
        finish(new Error(`JAVHDPorn JWPlayer decoder returned invalid JSON${stderr ? `: ${stderr}` : ''}`));
        return;
      }

      if (code !== 0 || !payload?.ok) {
        finish(new Error(payload?.error || stderr || `JAVHDPorn JWPlayer decoder exited with code ${code}`));
        return;
      }
      finish(null, payload);
    });

    child.stdin.on('error', error => finish(error));
    child.stdin.end(JSON.stringify({ html, script, playerUrl }));
  });
}

module.exports = {
  captureJwPlayerSources,
  getPlayerConfigMetadata,
  isJavPlayerHost,
};
