'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', '.python-venv', '__pycache__']);

function listTestFiles(root) {
  const files = [];
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.test.js')) files.push(target);
    }
  }
  walk(path.resolve(root));
  return files.sort();
}

function auditReleaseVersionAssertions(root, targetVersion) {
  const target = String(targetVersion || '').trim();
  if (!/^2\.7\.0-alpha\.\d+$/.test(target)) {
    throw new Error(`Invalid target release version: ${target || '<empty>'}`);
  }
  const files = listTestFiles(root);
  const mismatches = [];
  const assertion = /assert\.(?:equal|strictEqual)\([\s\S]{0,240}?\.version\s*,\s*(['"])(2\.7\.0-alpha\.\d+)\1/g;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(assertion)) {
      if (match[2] !== target) {
        mismatches.push(`${path.relative(root, file)} -> ${match[2]}`);
      }
    }
  }
  if (mismatches.length) {
    throw new Error(`Release-version assertions do not match ${target}: ${mismatches.join(', ')}`);
  }
  return { files: files.length, mismatches: [] };
}

function patchRetainedReleaseVersions(root, previousVersion, targetVersion) {
  const previous = String(previousVersion || '').trim();
  const target = String(targetVersion || '').trim();
  if (!/^2\.7\.0-alpha\.\d+$/.test(previous) || !/^2\.7\.0-alpha\.\d+$/.test(target)) {
    throw new Error('Previous and target versions must use 2.7.0-alpha.N format');
  }
  const changed = [];
  for (const file of listTestFiles(root)) {
    const original = fs.readFileSync(file, 'utf8');
    const updated = original
      .replaceAll(`'${previous}'`, `'${target}'`)
      .replaceAll(`"${previous}"`, `"${target}"`);
    if (updated !== original) {
      fs.writeFileSync(file, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8');
      changed.push(path.relative(root, file));
    }
  }
  auditReleaseVersionAssertions(root, target);
  return { changed, files: listTestFiles(root).length };
}

if (require.main === module) {
  const [mode, root, first, second] = process.argv.slice(2);
  try {
    if (mode === '--audit') {
      const result = auditReleaseVersionAssertions(root, first);
      console.log(`Version consistency audit passed across ${result.files} retained test files (${first}).`);
    } else if (mode === '--patch') {
      const result = patchRetainedReleaseVersions(root, first, second);
      console.log(`Updated ${result.changed.length} retained test files; audited ${result.files}.`);
    } else {
      throw new Error('Usage: --audit ROOT TARGET or --patch ROOT PREVIOUS TARGET');
    }
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  }
}

module.exports = {
  auditReleaseVersionAssertions,
  listTestFiles,
  patchRetainedReleaseVersions,
};
