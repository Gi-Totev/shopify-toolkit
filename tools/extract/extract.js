#!/usr/bin/env node
'use strict';

/*
 * extract — pull every SVG out of a URL or HTML file.
 *
 * Sources: inline <svg>, linked .svg (img/object/embed/use/image/link/source),
 * CSS url(...), and data:image/svg+xml. Writes into stk-extracted-svgs/
 * in the current directory (a new -N if that exists). Never touches the source.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const OUT_BASE = 'stk-extracted-svgs';
const UA = 'stk';
const TIMEOUT_MS = 20000;

function usage() {
  console.log(`stk extract — pull SVGs from a URL or HTML file

Usage:
  stk extract <url|file>

Writes every SVG (inline, linked .svg, CSS url(), data URIs)
into stk-extracted-svgs/ in the current directory
(a new -N if that exists). Never modifies the source.

Options:
  -h, --help         Show this help`);
}

function pickFolder(root, base) {
  let name = base;
  for (let n = 1; fs.existsSync(path.join(root, name)); n++) name = `${base}-${n}`;
  return path.join(root, name);
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isHttp(s) {
  return /^https?:\/\//i.test(s);
}

function findTagEnd(src, start) {
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

function sliceSvg(html, start) {
  const openEnd = findTagEnd(html, start);
  if (openEnd < 0) return null;
  const open = html.slice(start, openEnd);
  if (/\/\s*>$/.test(open)) return { raw: open, end: openEnd };

  let depth = 1;
  let i = openEnd;
  while (i < html.length && depth > 0) {
    const rest = html.slice(i);
    const nextOpen = rest.search(/<svg\b/i);
    const nextClose = rest.search(/<\/svg\s*>/i);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      const abs = i + nextOpen;
      const tagEnd = findTagEnd(html, abs);
      if (tagEnd < 0) return null;
      if (!/\/\s*>$/.test(html.slice(abs, tagEnd))) depth++;
      i = tagEnd;
    } else {
      const abs = i + nextClose;
      const m = html.slice(abs).match(/^<\/svg\s*>/i);
      i = abs + m[0].length;
      depth--;
      if (depth === 0) return { raw: html.slice(start, i), end: i };
    }
  }
  return null;
}

function extractInline(html) {
  const out = [];
  let i = 0;
  while (i < html.length) {
    const rel = html.slice(i).search(/<svg\b/i);
    if (rel === -1) break;
    const abs = i + rel;
    const block = sliceSvg(html, abs);
    if (!block) { i = abs + 4; continue; }
    out.push(block.raw);
    i = block.end;
  }
  return out;
}

function isSvgUrl(raw) {
  const t = raw.trim();
  if (!t || /^data:/i.test(t) || t.startsWith('#')) return false;
  try {
    return /\.svg$/i.test(new URL(t, 'http://dummy.invalid').pathname);
  } catch {
    return /\.svg(\?|#|$)/i.test(t);
  }
}

function addRef(ref, into) {
  const t = String(ref || '').trim();
  if (!t || t.startsWith('#') || /^javascript:/i.test(t)) return;
  if (/^data:image\/svg\+xml/i.test(t)) { into.data.push(t); return; }
  if (/^data:/i.test(t)) return;
  if (isSvgUrl(t)) into.urls.push(t);
}

function collectCssUrls(css, into) {
  const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
  let m;
  while ((m = re.exec(css)) !== null) addRef(m[2], into);
}

function attrVal(m) {
  return m[2] !== undefined ? m[2] : m[3];
}

function collectFromHtml(html) {
  const into = { urls: [], data: [] };

  const attrRe = /\b(src|href|data|srcset|xlink:href)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[3] !== undefined ? m[3] : m[4];
    if (name === 'srcset') {
      for (const part of val.split(',')) {
        const u = part.trim().split(/\s+/)[0];
        if (u) addRef(u, into);
      }
    } else {
      addRef(val, into);
    }
  }

  const styleRe = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = styleRe.exec(html)) !== null) collectCssUrls(attrVal(m), into);

  const tagStyle = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = tagStyle.exec(html)) !== null) collectCssUrls(m[1], into);

  const sheets = [];
  const linkRe = /<link\b[^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\bstylesheet\b/i.test(tag)) continue;
    const hm = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)')/i);
    if (hm) sheets.push(hm[2] !== undefined ? hm[2] : hm[3]);
  }

  return { inline: extractInline(html), ...into, sheets };
}

function decodeDataUri(uri) {
  const m = uri.match(/^data:image\/svg\+xml([^,]*),(.*)$/is);
  if (!m) return null;
  try {
    if (/;base64/i.test(m[1])) return Buffer.from(m[2], 'base64').toString('utf8');
    return decodeURIComponent(m[2]);
  } catch {
    return null;
  }
}

function isSvgDocument(text) {
  const t = text
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();
  return /^<svg\b/i.test(t);
}

function resolveRef(ref, base) {
  const t = ref.trim();
  if (t.startsWith('//')) return 'https:' + t;
  try { return new URL(t, base).href; } catch { return null; }
}

function sanitize(name) {
  let s = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/^\.+/g, '')
    .trim();
  if (!s) s = 'svg';
  if (!/\.svg$/i.test(s)) s += '.svg';
  return s;
}

function nameFromUrl(url) {
  try {
    const base = path.basename(new URL(url).pathname);
    if (base && /\.svg$/i.test(base)) return sanitize(decodeURIComponent(base));
  } catch { /* ignore */ }
  return null;
}

function nameFromInline(raw) {
  const id = raw.match(/\bid\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (id) {
    const v = (id[2] !== undefined ? id[2] : id[3]).trim();
    if (v) return sanitize(v);
  }
  const al = raw.match(/\baria-label\s*=\s*("([^"]*)"|'([^']*)')/i);
  if (al) {
    const v = (al[2] !== undefined ? al[2] : al[3]).trim();
    if (v) return sanitize(v);
  }
  return null;
}

function uniqueName(used, name) {
  const ext = path.extname(name) || '.svg';
  const stem = name.slice(0, name.length - ext.length) || 'svg';
  let out = name;
  let n = 1;
  while (used.has(out.toLowerCase())) {
    out = `${stem}-${n}${ext}`;
    n++;
  }
  used.add(out.toLowerCase());
  return out;
}

async function load(url) {
  if (url.startsWith('file:')) return fs.readFileSync(fileURLToPath(url));
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(String(res.status));
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '-h' || arg === '--help') { usage(); process.exit(arg ? 0 : 1); }
  if (arg.startsWith('-')) { console.error(`Unknown flag: ${arg}`); process.exit(1); }

  let base;
  let buf;
  if (isHttp(arg)) {
    base = arg;
    try { buf = await load(arg); }
    catch (e) { console.error(`stk extract: failed to fetch ${arg}: ${e.message}`); process.exit(1); }
  } else {
    const file = path.resolve(expandHome(arg));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      console.error(`stk extract: not a file: ${file}`);
      process.exit(1);
    }
    base = pathToFileURL(file).href;
    buf = fs.readFileSync(file);
  }

  const text = buf.toString('utf8');
  const used = new Set();
  let destDir = null;
  let seq = 1;
  let written = 0;
  let warned = 0;

  function ensureDir() {
    if (!destDir) {
      destDir = pickFolder(process.cwd(), OUT_BASE);
      fs.mkdirSync(destDir, { recursive: true });
    }
    return destDir;
  }

  function write(name, content) {
    const file = uniqueName(used, name);
    fs.writeFileSync(path.join(ensureDir(), file), content);
    console.log(`+ ${file}`);
    written++;
  }

  if (isSvgDocument(text) || /\.svg$/i.test(new URL(base).pathname)) {
    write(nameFromUrl(base) || `svg-${seq++}.svg`, buf);
    console.log(`\n${written} SVG(s) written to ${path.relative(process.cwd(), destDir) || destDir}/`);
    return;
  }

  const found = collectFromHtml(text);
  const seen = new Set();

  for (const raw of found.inline) {
    write(nameFromInline(raw) || `svg-${seq++}.svg`, raw);
  }

  const dataSeen = new Set();
  for (const uri of found.data) {
    if (dataSeen.has(uri)) continue;
    dataSeen.add(uri);
    const decoded = decodeDataUri(uri);
    if (decoded == null) {
      console.error(`! data URI: could not decode`);
      warned++;
      continue;
    }
    write(nameFromInline(decoded) || `svg-${seq++}.svg`, decoded);
  }

  for (const href of found.sheets) {
    const abs = resolveRef(href, base);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    let css;
    try { css = (await load(abs)).toString('utf8'); }
    catch (e) { console.error(`! ${abs}: ${e.message}`); warned++; continue; }
    const extra = { urls: [], data: [] };
    collectCssUrls(css, extra);
    found.urls.push(...extra.urls);
    found.data.push(...extra.data);
  }

  for (const uri of found.data) {
    if (dataSeen.has(uri)) continue;
    dataSeen.add(uri);
    const decoded = decodeDataUri(uri);
    if (decoded == null) {
      console.error(`! data URI: could not decode`);
      warned++;
      continue;
    }
    write(nameFromInline(decoded) || `svg-${seq++}.svg`, decoded);
  }

  for (const ref of found.urls) {
    const abs = resolveRef(ref, base);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    try {
      const body = await load(abs);
      write(nameFromUrl(abs) || `svg-${seq++}.svg`, body);
    } catch (e) {
      console.error(`! ${abs}: ${e.message}`);
      warned++;
    }
  }

  if (written === 0) {
    console.error('stk extract: no SVGs found.');
    process.exit(1);
  }
  console.log(`\n${written} SVG(s) written to ${path.relative(process.cwd(), destDir) || destDir}/`);
  if (warned) console.error(`${warned} skipped.`);
}

main().catch((e) => { console.error(`stk extract: ${e.message}`); process.exit(1); });
