#!/usr/bin/env node
'use strict';

/*
 * svg-prep — prepare SVGs for upload to Shopify as image files.
 *
 * Ensures each SVG has the attributes Shopify's uploader/sanitizer requires:
 *   - xmlns="http://www.w3.org/2000/svg"   (required; upload fails without it)
 *   - width / height on the root            (intrinsic size; derived from viewBox)
 *   - viewBox                               (scaling; derived from width/height)
 *   - xmlns:xlink                           (only if the file uses xlink:)
 * And strips content Shopify rejects: <script> elements and inline on*= handlers.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function parseArgs(argv) {
  const opts = { inputs: [], out: null, forceSize: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') opts.out = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { console.error(`Unknown flag: ${a}`); process.exit(1); }
    else opts.inputs.push(a);
  }
  opts.interactive = opts.inputs.length === 0 && !opts.help; // no path → fzf flow
  return opts;
}

function usage() {
  console.log(`stk svg — prep SVGs for Shopify image upload

Usage:
  stk svg [file.svg | folder] [options]     (no path → choose folder or files)

Fixes everything by default (in place): xmlns, width/height, viewBox,
xmlns:xlink, strips scripts/handlers, and converts % sizes to absolute.

Options:
  -o, --out <dir>    Write fixed files to <dir> instead of in place
  -h, --help         Show this help

Folders are scanned recursively for .svg.`);
}

function fzf(candidates, flags) {
  try {
    execSync('command -v fzf', { stdio: 'ignore' });
  } catch {
    console.error('fzf not installed. Run: brew install fzf'); process.exit(1);
  }
  try {
    const out = execSync(`fzf ${flags}`, {
      input: candidates.join('\n'),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // ESC / no selection
  }
}

// No path given: pick whole current folder, or fzf-select specific files.
function interactiveSelect() {
  const mode = fzf(['entire folder (all .svg here)', 'specific files (pick with fzf)'],
    "--prompt='svg > ' --height=15% --reverse")[0];
  if (!mode) return null;
  if (mode.startsWith('entire')) return collectFiles(['.']);

  const all = collectFiles(['.']);
  if (all.length === 0) { console.error('No .svg files in current folder.'); return []; }
  return fzf(all, "--multi --prompt='files (tab to mark) > ' --height=60% --reverse");
}

function collectFiles(inputs) {
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    } else if (st.isFile() && p.toLowerCase().endsWith('.svg')) {
      files.push(p);
    }
  };
  for (const input of inputs) {
    if (!fs.existsSync(input)) { console.error(`Not found: ${input}`); continue; }
    walk(input);
  }
  return files;
}

// Find the root <svg ...> opening tag, respecting quoted attribute values.
function findRootTag(src) {
  const start = src.search(/<svg\b/i);
  if (start === -1) return null;
  let i = start;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') break;
  }
  if (i >= src.length) return null;
  const selfClosing = src[i - 1] === '/';
  const end = i + 1;
  return { start, end, raw: src.slice(start, end), selfClosing };
}

// Parse attributes of an opening tag into an ordered list.
function parseAttrs(rawTag) {
  const inner = rawTag.replace(/^<svg\b/i, '').replace(/\/?>$/, '');
  const attrs = [];
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    attrs.push({ name: m[1], value: m[3] !== undefined ? m[3] : m[4], quote: m[2][0] });
  }
  return attrs;
}

function getAttr(attrs, name) {
  const lc = name.toLowerCase();
  return attrs.find((a) => a.name.toLowerCase() === lc);
}

function buildTag(attrs, selfClosing) {
  const parts = attrs.map((a) => `${a.name}=${a.quote || '"'}${a.value}${a.quote || '"'}`);
  return `<svg ${parts.join(' ')}${selfClosing ? ' /' : ''}>`;
}

function numFromDim(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(-?\d*\.?\d+)\s*(px)?$/i);
  return m ? parseFloat(m[1]) : null; // null => missing/percentage/unsupported unit
}

function processSvg(src, opts) {
  const notes = [];
  const root = findRootTag(src);
  if (!root) return { changed: false, notes: ['no <svg> root found — skipped'], out: src };

  const attrs = parseAttrs(root.raw);
  let changed = false;

  // 1. xmlns (required)
  if (!getAttr(attrs, 'xmlns')) {
    attrs.unshift({ name: 'xmlns', value: SVG_NS, quote: '"' });
    notes.push('added xmlns');
    changed = true;
  }

  // viewBox parse (minx miny w h)
  const vbAttr = getAttr(attrs, 'viewBox');
  let vb = null;
  if (vbAttr) {
    const p = vbAttr.value.trim().split(/[\s,]+/).map(Number);
    if (p.length === 4 && p.every((n) => Number.isFinite(n))) vb = p;
  }

  const wAttr = getAttr(attrs, 'width');
  const hAttr = getAttr(attrs, 'height');
  const wNum = wAttr ? numFromDim(wAttr.value) : null;
  const hNum = hAttr ? numFromDim(hAttr.value) : null;
  const isPct = (a) => a && /%$/.test(a.value.trim());

  // 2. width/height from viewBox when missing (or percentage w/ --force-size)
  const needW = !wAttr || (opts.forceSize && isPct(wAttr));
  const needH = !hAttr || (opts.forceSize && isPct(hAttr));
  if ((needW || needH) && vb) {
    if (needW) {
      if (wAttr) wAttr.value = String(vb[2]); else attrs.push({ name: 'width', value: String(vb[2]), quote: '"' });
      notes.push(`set width=${vb[2]} from viewBox`);
      changed = true;
    }
    if (needH) {
      if (hAttr) hAttr.value = String(vb[3]); else attrs.push({ name: 'height', value: String(vb[3]), quote: '"' });
      notes.push(`set height=${vb[3]} from viewBox`);
      changed = true;
    }
  } else if ((!wAttr || !hAttr) && !vb) {
    notes.push('WARN: no width/height and no viewBox — cannot derive size');
  }

  // 3. viewBox from width/height when missing
  if (!vb && wNum != null && hNum != null) {
    attrs.push({ name: 'viewBox', value: `0 0 ${wNum} ${hNum}`, quote: '"' });
    notes.push(`added viewBox=0 0 ${wNum} ${hNum}`);
    changed = true;
  }

  // percentage sizing warning (when not forced)
  if (!opts.forceSize && (isPct(wAttr) || isPct(hAttr))) {
    notes.push('WARN: percentage width/height — Shopify may reject (use --force-size)');
  }

  // 4. xmlns:xlink when xlink: is used
  if (/\bxlink:/.test(src) && !getAttr(attrs, 'xmlns:xlink')) {
    attrs.push({ name: 'xmlns:xlink', value: XLINK_NS, quote: '"' });
    notes.push('added xmlns:xlink');
    changed = true;
  }

  // rebuild root tag
  let out = src.slice(0, root.start) + buildTag(attrs, root.selfClosing) + src.slice(root.end);

  // 5. strip <script> elements
  if (/<script[\s>]/i.test(out)) {
    out = out.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
    notes.push('stripped <script> (Shopify rejects)');
    changed = true;
  }

  // 6. strip inline on*= event handlers
  if (/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/i.test(out)) {
    out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
    notes.push('stripped inline on*= handlers');
    changed = true;
  }

  // 7. drop Illustrator cruft: unused ids + data-name (keep referenced ids)
  const ids = cleanIds(out);
  if (ids.out !== out) changed = true;
  out = ids.out;
  notes.push(...ids.notes);

  return { changed, notes, out };
}

// Collect every id the document actually points at.
function referencedIds(src) {
  const refs = new Set();
  const add = (re) => { let m; while ((m = re.exec(src)) !== null) refs.add(m[1]); };
  add(/url\(\s*#([^\s)"']+)\s*\)/g);              // fill="url(#grad)", clip-path, mask...
  add(/(?:xlink:)?href\s*=\s*["']#([^"']+)["']/g); // <use href="#x">
  add(/\b(?:aria-labelledby|aria-describedby)\s*=\s*["']([^"']+)["']/g);
  // ids referenced from <style> selectors
  let styles = '', sm; const styleRe = /<style[\s\S]*?<\/style>/gi;
  while ((sm = styleRe.exec(src)) !== null) styles += sm[0];
  let m; const idSel = /#([A-Za-z_][\w-]*)/g;
  while ((m = idSel.exec(styles)) !== null) refs.add(m[1]);
  return refs;
}

function cleanIds(src) {
  const notes = [];
  const refs = referencedIds(src);

  let removed = 0;
  let out = src.replace(/\s(?:xml:)?id\s*=\s*("([^"]*)"|'([^']*)')/gi, (full, _q, dv, sv) => {
    const val = dv !== undefined ? dv : sv;
    if (refs.has(val)) return full; // referenced → keep
    removed++;
    return '';
  });
  if (removed) notes.push(`removed ${removed} unused id${removed > 1 ? 's' : ''}`);

  let dn = 0;
  out = out.replace(/\sdata-name\s*=\s*("[^"]*"|'[^']*')/gi, () => { dn++; return ''; });
  if (dn) notes.push(`removed ${dn} data-name`);

  // any duplicate ids left are referenced ones we can't safely rewrite
  const counts = {}; let km;
  const keptRe = /\s(?:xml:)?id\s*=\s*"([^"]*)"/gi;
  while ((km = keptRe.exec(out)) !== null) counts[km[1]] = (counts[km[1]] || 0) + 1;
  const dups = Object.keys(counts).filter((k) => counts[k] > 1);
  if (dups.length) notes.push(`WARN: duplicate referenced id(s), fix manually: ${dups.join(', ')}`);

  return { out, notes };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); process.exit(0); }

  let files;
  if (opts.interactive) {
    files = interactiveSelect();
    if (files === null) { console.log('cancelled.'); process.exit(0); }
  } else {
    files = collectFiles(opts.inputs);
  }
  if (files.length === 0) { console.error('No .svg files found.'); process.exit(1); }

  if (opts.out) fs.mkdirSync(opts.out, { recursive: true });

  let touched = 0, warned = 0;
  for (const file of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); }
    catch (e) { console.error(`✗ ${file}: ${e.message}`); continue; }

    const res = processSvg(src, opts);
    const hasWarn = res.notes.some((n) => n.startsWith('WARN'));
    if (hasWarn) warned++;

    const tag = res.changed ? 'FIXED' : 'ok';
    const label = res.notes.length ? ` — ${res.notes.join('; ')}` : '';
    console.log(`${res.changed ? '✎' : '·'} ${tag}: ${file}${label}`);

    if (res.changed) {
      const dest = opts.out ? path.join(opts.out, path.basename(file)) : file;
      fs.writeFileSync(dest, res.out);
      touched++;
    }
  }

  console.log(`\n${files.length} file(s) scanned, ${touched} written, ${warned} warning(s).`);
}

main();
