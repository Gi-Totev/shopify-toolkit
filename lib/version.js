'use strict';
// Update check. Compares the installed package.json version against the repo's
// package.json on GitHub main. Remote result cached once/day; offline-safe.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { spawnSync } = require('child_process');

const PKG = path.join(__dirname, '..', 'package.json');
const REPO_SPEC = 'github:Gi-Totev/shopify-toolkit';
const RAW_URL = 'https://raw.githubusercontent.com/Gi-Totev/shopify-toolkit/main/package.json';
const CACHE = path.join(os.homedir(), '.stk', 'update-check.json');
const TTL_MS = 24 * 60 * 60 * 1000;

function installedVersion() {
  try { return JSON.parse(fs.readFileSync(PKG, 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
}

// -1 if a<b, 0 if equal, 1 if a>b
function cmpSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}

function writeCache(obj) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(obj));
  } catch { /* cache is best-effort */ }
}

function fetchRemoteVersion(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = https.get(RAW_URL, { headers: { 'User-Agent': 'stk' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).version || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

async function checkForUpdate() {
  const installed = installedVersion();
  const cache = readCache();
  const now = Date.now();
  let latest = cache && cache.latest;

  if (!cache || (now - (cache.checkedAt || 0)) > TTL_MS) {
    const remote = await fetchRemoteVersion();
    if (remote) { latest = remote; writeCache({ latest, checkedAt: now }); }
  }

  if (!latest) return { installed, latest: null, updateAvailable: false };
  return { installed, latest, updateAvailable: cmpSemver(installed, latest) < 0 };
}

function runUpdate() {
  console.log(`stk: updating from ${REPO_SPEC} ...`);
  const r = spawnSync('npm', ['i', '-g', REPO_SPEC], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm is npm.cmd on Windows
  });
  try { fs.unlinkSync(CACHE); } catch { /* ignore */ }
  return r.status == null ? 1 : r.status;
}

module.exports = { installedVersion, checkForUpdate, runUpdate };
