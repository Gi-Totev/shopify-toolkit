'use strict';
// fzf picker. Cross-platform (Windows/mac/linux). Items are strings or { label }.

const { spawnSync } = require('child_process');

function labelOf(it) { return typeof it === 'string' ? it : it.label; }

function ensureFzf() {
  const probe = process.platform === 'win32'
    ? spawnSync('where', ['fzf'], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', 'command -v fzf'], { stdio: 'ignore' });
  if (probe.status !== 0) {
    console.error('fzf required. Install: https://github.com/junegunn/fzf');
    process.exit(1);
  }
}

function fzfPick(labels, prompt, multi) {
  const args = ['--prompt', prompt, '--height', '40%', '--reverse'];
  if (multi) args.push('--multi');
  const r = spawnSync('fzf', args, {
    input: labels.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (r.status !== 0 || !r.stdout) return multi ? [] : null;
  const out = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return multi ? out : (out[0] || null);
}

function pick(items, prompt, multi) {
  if (items.length === 0) return multi ? [] : null;
  if (!process.stdin.isTTY) return multi ? [] : null; // no terminal → fzf would hang
  ensureFzf();
  return fzfPick(items.map(labelOf), prompt, multi);
}

const pickOne = (items, prompt = '> ') => pick(items, prompt, false);
const pickMany = (items, prompt = '> ') => pick(items, prompt, true);

module.exports = { pickOne, pickMany };
