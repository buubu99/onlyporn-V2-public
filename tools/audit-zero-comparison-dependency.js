'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOTS = ['addon.js', 'server.js', 'provider', 'catalog', 'server-sdk', 'scripts', 'tools'];
const EXCLUDED = new Set(['node_modules', '.git', '.python-venv', '__pycache__']);
const FORBIDDEN = [
  { label: 'external comparison addon domain', regex: /tpb-adult-addon\.click/i },
  { label: 'external comparison addon display name', regex: /TPB\s*4K\s*IMPROVED/i },
  { label: 'external comparison addon instance ID', regex: /t4ke3b0/i },
  { label: 'shared external Hentai ID prefix', regex: /(['"`])hmm-/i },
];

function files(root) {
  const output = [];
  const visit = target => {
    if (!fs.existsSync(target)) return;
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      const base = path.basename(target);
      if (target.endsWith('.js') && !target.endsWith('.test.js') && base !== 'audit-zero-comparison-dependency.js') output.push(target);
      return;
    }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      visit(path.join(target, entry.name));
    }
  };
  for (const value of ROOTS) visit(path.join(root, value));
  return output;
}

function audit(root) {
  const failures = [];
  for (const file of files(root)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const rule of FORBIDDEN) {
      if (rule.regex.test(source)) failures.push(`${path.relative(root, file)}: ${rule.label}`);
    }
  }
  const addon = path.join(root, 'addon.js');
  if (fs.existsSync(addon)) {
    const source = fs.readFileSync(addon, 'utf8');
    if (!source.includes("idPrefixes: ['onlyporn:', 'ophmm-', 'ophtop-']")) failures.push('addon.js: missing exclusive OnlyPorn idPrefixes');
  }
  if (failures.length) throw new Error(`Zero-dependency audit failed:\n- ${failures.join('\n- ')}`);
  return { files: files(root).length };
}

if (require.main === module) {
  try {
    const result = audit(path.resolve(process.argv[2] || process.cwd()));
    console.log(`Zero-comparison-dependency audit passed across ${result.files} runtime JavaScript files.`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}

module.exports = { audit };
