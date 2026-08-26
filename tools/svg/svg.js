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
 * Also inlines Illustrator's CSS classes (.st0 { fill:... }) as presentation
 * attributes so elements carry their own fill/stroke without a <style> block.
 */

const fs = require('fs');
const path = require('path');

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

// CSS properties that are also valid SVG presentation attributes — safe to inline.
const SVG_PRESENTATION = new Set([
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'color', 'display', 'visibility',
  'stop-color', 'stop-opacity', 'clip-rule',
]);

function parseArgs(argv) {
  const opts = { inputs: [], forceSize: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { console.error(`Unknown flag: ${a}`); process.exit(1); }
    else opts.inputs.push(a);
  }
  return opts;
}

function usage() {
  console.log(`stk svg — prep SVGs for Shopify image upload

Usage:
  stk svg [folder]      (no folder -> current directory)

Writes to svg-ready/ inside the target folder (a new -N if that exists)
and never modifies originals.

Fixes xmlns, width/height, viewBox, xmlns:xlink; strips scripts/handlers;
converts % sizes to absolute; inlines Illustrator CSS classes
(.st0 { fill:... }) as attributes.

Options:
  -h, --help         Show this help

Folders are scanned recursively for .svg.`);
}

function pickFolder(root, base) {
  let name = base;
  for (let n = 1; fs.existsSync(path.join(root, name)); n++) name = `${base}-${n}`;
  return path.join(root, name);
}

function collectFiles(inputs) {
  const files = [];
  const walk = (p) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (/^svg-ready(-\d+)?$/.test(path.basename(p))) return;
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

  // 8. inline Illustrator CSS classes (.st0 { fill:... }) as presentation attributes
  const inl = inlineClasses(out);
  if (inl.changed) changed = true;
  out = inl.out;
  notes.push(...inl.notes);

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

// Parse a rule body ("fill:#f00; stroke:none") into ordered {prop, value} decls.
function parseDecls(body) {
  return body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const i = d.indexOf(':');
    if (i < 0) return null;
    const prop = d.slice(0, i).trim().toLowerCase();
    const value = d.slice(i + 1).trim().replace(/\s*!important\s*$/i, '');
    return value ? { prop, value } : null;
  }).filter(Boolean);
}

// Walk a <style> body, harvest pure single-class rules into `map`, return the CSS
// that stays behind (id/element/descendant selectors we can't safely flatten).
function collectClassRules(css, map) {
  let consumedAny = false;
  const remaining = css.replace(/([^{}]+)\{([^{}]*)\}/g, (full, sel, body) => {
    const selectors = sel.split(',').map((s) => s.trim()).filter(Boolean);
    const allSimpleClass = selectors.length > 0 && selectors.every((s) => /^\.[A-Za-z_][\w-]*$/.test(s));
    if (!allSimpleClass) return full;
    const decls = parseDecls(body);
    if (!decls.length) return '';
    if (!decls.every((d) => SVG_PRESENTATION.has(d.prop))) return full; // has non-presentation prop → leave as CSS
    for (const s of selectors) {
      const cls = s.slice(1);
      (map[cls] ||= []).push(...decls);
    }
    consumedAny = true;
    return '';
  });
  return { remaining, consumedAny };
}

// Parse a tag's attribute string into an ordered list (quoted or unquoted values).
function parseTagAttrs(str) {
  const attrs = [];
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const value = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
    const q = m[2][0] === '"' || m[2][0] === "'" ? m[2][0] : '"';
    attrs.push({ name: m[1], value, quote: q });
  }
  return attrs;
}

// Replace Illustrator CSS classes with inline presentation attributes.
function inlineClasses(src) {
  const notes = [];
  const map = {};
  let styleChanged = false;
  let removedBlocks = 0;

  let out = src.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (full, css) => {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const { remaining, consumedAny } = collectClassRules(clean, map);
    if (!consumedAny) return full;
    styleChanged = true;
    if (remaining.trim() === '') { removedBlocks++; return ''; }
    return full.replace(css, remaining);
  });

  const classNames = Object.keys(map);
  if (!classNames.length) return { out: src, notes, changed: false };

  // Classes still carrying a definition in a surviving <style> block — keep those.
  const keptClasses = new Set();
  let sm;
  const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((sm = styleRe.exec(out)) !== null) {
    let cm;
    const clsRe = /\.([A-Za-z_][\w-]*)/g;
    while ((cm = clsRe.exec(sm[1])) !== null) keptClasses.add(cm[1]);
  }

  let elCount = 0;
  out = out.replace(
    /<([a-zA-Z][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))*)\s*(\/?)>/g,
    (m, name, attrsStr, slash) => {
      if (!/\bclass\s*=/.test(attrsStr)) return m;
      const attrs = parseTagAttrs(attrsStr);
      const classAttr = attrs.find((a) => a.name.toLowerCase() === 'class');
      if (!classAttr) return m;

      const classes = classAttr.value.split(/\s+/).filter(Boolean);
      const inlinable = classes.filter((c) => map[c]);
      const leftover = classes.filter((c) => !map[c] && keptClasses.has(c)); // still has a rule
      const dead = classes.filter((c) => !map[c] && !keptClasses.has(c));    // references nothing
      if (!inlinable.length && !dead.length) return m; // only kept-rule classes → untouched

      // Later class wins on conflicting props (CSS source order).
      const propMap = {};
      for (const c of classes) if (map[c]) for (const d of map[c]) propMap[d.prop] = d.value;
      const inlined = Object.keys(propMap).map((p) => ({ name: p, value: propMap[p], quote: '"' }));

      const newAttrs = [];
      for (const a of attrs) {
        if (a === classAttr) {
          if (leftover.length) newAttrs.push({ name: 'class', value: leftover.join(' '), quote: classAttr.quote });
          newAttrs.push(...inlined);
        } else if (propMap[a.name.toLowerCase()] !== undefined) {
          continue; // style-block CSS outranks a presentation attribute → drop the old one
        } else {
          newAttrs.push(a);
        }
      }

      elCount++;
      const attrStr = newAttrs.map((a) => `${a.name}=${a.quote}${a.value}${a.quote}`).join(' ');
      return `<${name}${attrStr ? ' ' + attrStr : ''}${slash ? ' /' : ''}>`;
    },
  );

  // Drop now-empty <defs> wrappers left behind after removing the <style>.
  let emptyDefs = 0;
  out = out.replace(/\s*<defs\b[^>]*>\s*<\/defs>/gi, () => { emptyDefs++; return ''; });

  if (elCount) notes.push(`inlined ${classNames.length} class rule${classNames.length > 1 ? 's' : ''} onto ${elCount} element${elCount > 1 ? 's' : ''}`);
  if (removedBlocks) notes.push(`removed ${removedBlocks} <style> block${removedBlocks > 1 ? 's' : ''}`);
  if (emptyDefs) notes.push(`removed ${emptyDefs} empty <defs>`);
  return { out, notes, changed: styleChanged || elCount > 0 || emptyDefs > 0 };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); process.exit(0); }

  const folder = opts.inputs[0] || '.';
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    console.error(`stk svg: not a folder: ${path.resolve(folder)}`);
    process.exit(1);
  }

  const files = collectFiles([folder]);
  if (files.length === 0) { console.error('No .svg files found.'); process.exit(1); }

  const root = path.resolve(folder);
  const destDir = pickFolder(root, 'svg-ready');
  fs.mkdirSync(destDir, { recursive: true });

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

    const rel = path.relative(root, path.resolve(file));
    const outRel = (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? path.basename(file) : rel;
    const dest = path.join(destDir, outRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, res.out);
    touched++;
  }

  console.log(`\n${files.length} file(s) scanned, ${touched} written, ${warned} warning(s).`);
}

main();
