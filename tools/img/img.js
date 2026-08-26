#!/usr/bin/env node
'use strict';

/*
 * img — prepare a folder of raster images for MANUAL upload to Shopify.
 *
 * Non-destructive. Reads a target folder (recursively), mirrors its tree into
 * output folders created inside the target, and never touches originals.
 *
 * Routing per image (jpg/png/webp/gif/heic/tiff; other files ignored):
 *   - CMYK (JPEG/TIFF)       -> cmyk/          (verbatim; Shopify wants RGB, can't
 *                                               convert without a colour engine)
 *   - non-sRGB profile       -> color-check/   (verbatim; AdobeRGB/DisplayP3 shift
 *                                               on Shopify's CDN, can't convert here)
 *   - clean RGB/grayscale    -> shopify-ready/ (verbatim if within limits, else
 *                                               resized <=25MP and/or shrunk <20MB)
 *
 * Re-encoding stays in the source format and preserves animation (gif/webp).
 * Lossy only when a limit is breached:
 *   - >25MP  -> resize keeping aspect ratio to ~24.9MP; EXIF orientation baked in.
 *              JPEG re-encoded at sourceQuality-10 (100 -> 90, floor 40).
 *   - >20MB  -> lossy formats: binary-search quality; png/gif: binary-search scale.
 *
 * jpg/png detection is pure-Node marker parsing (also yields JPEG source quality
 * + EXIF orientation); webp/gif/heic/tiff use a sharp header read.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const MB = 1024 * 1024;
const SIZE_LIMIT = 20 * MB;            // Shopify's hard file-size cap
const SIZE_TARGET = Math.floor(19.5 * MB); // aim under this when reducing
const SIZE_GOOD = Math.floor(18.5 * MB);   // early-exit band lower bound
const PX_LIMIT = 25_000_000;           // Shopify's hard megapixel cap (5000x5000)
const PX_TARGET = 24_900_000;          // resize target, just under the cap
const PX_FLOOR = 1_000_000;            // never shrink below ~1MP
const FALLBACK_Q = 90;                 // JPEG quality when source can't be read
const FLOOR_Q = 40;
const MAX_ITERS = 8;

const OUT = { ready: 'shopify-ready', cmyk: 'cmyk', color: 'color-check' };
const SKIP_DIR = /^(shopify-ready|cmyk|color-check)(-\d+)?$/;
const IMG_EXT = /\.(jpe?g|png|webp|gif|tiff?|hei[cf])$/i;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.log(`stk img — prep images for manual Shopify upload

Usage:
  stk img [folder]      (no folder -> current directory)

Recursively scans <folder>, mirrors its tree into output folders created
inside it, and never modifies originals:

  shopify-ready/   upload-ready set (resized <=25MP, <20MB as needed)
  cmyk/            CMYK images — convert to sRGB before upload
  color-check/     non-sRGB profile images — convert to sRGB before upload

Processes jpg/jpeg/png/webp/gif/heic/tiff; all other files are ignored.
Output keeps the source format and any animation. Existing output folders
are left alone (a new -N is created).`);
}

// ---------------------------------------------------------------------------
// Pure-Node image inspection
// ---------------------------------------------------------------------------

// Standard JPEG luminance quantization table, natural (row) order.
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];

// Zigzag index -> natural index, to de-zigzag a stored quant table.
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

// Estimate libjpeg quality (1-100) from a luminance quant table, or null.
function estimateQuality(qtableZigzag) {
  if (!qtableZigzag || qtableZigzag.length !== 64) return null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < 64; i++) {
    const qval = qtableZigzag[i];
    const std = STD_LUMA[ZIGZAG[i]];
    if (!qval || !std) continue;
    const scale = (qval * 100) / std; // libjpeg forward scaling, inverted
    const q = scale < 100 ? (200 - scale) / 2 : 5000 / scale;
    if (Number.isFinite(q)) { sum += q; n++; }
  }
  if (n === 0) return null;
  return Math.max(1, Math.min(100, Math.round(sum / n)));
}

// Is an ICC profile (or PNG profile name) sRGB? Present-but-not-sRGB -> divert.
function profileIsSRGB(bytes) {
  const s = bytes.toString('latin1');
  return /sRGB/i.test(s);
}

function inspectJpeg(buf) {
  const info = { format: 'jpeg', width: 0, height: 0, components: 0,
    orientation: 1, quality: null, colorSpace: 'srgb' };
  let lumaTable = null;
  const icc = [];
  let i = 2; // skip SOI
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    let marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }        // fill byte
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    if (marker >= 0xd0 && marker <= 0xd7) { i += 2; continue; } // RST
    const len = buf.readUInt16BE(i + 2);
    const seg = i + 4;
    if (marker === 0xdb) {                          // DQT
      let p = seg;
      const end = i + 2 + len;
      while (p < end) {
        const pq = buf[p] >> 4;                     // precision (0=8bit)
        const tq = buf[p] & 0x0f;                   // table id
        p++;
        const vals = [];
        const step = pq ? 2 : 1;
        for (let k = 0; k < 64; k++) {
          vals.push(pq ? buf.readUInt16BE(p) : buf[p]);
          p += step;
        }
        if (tq === 0 && !lumaTable && !pq) lumaTable = vals;
      }
    } else if (marker === 0xe1) {                   // APP1 (EXIF)
      info.orientation = readExifOrientation(buf, seg, len - 2) || 1;
    } else if (marker === 0xe2) {                   // APP2 (ICC chunk)
      if (buf.toString('latin1', seg, seg + 11) === 'ICC_PROFILE') {
        icc.push(buf.slice(seg + 14, i + 2 + len)); // skip id + seq/count
      }
    } else if (marker >= 0xc0 && marker <= 0xcf &&
               marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) { // SOF
      info.height = buf.readUInt16BE(seg + 1);
      info.width = buf.readUInt16BE(seg + 3);
      info.components = buf[seg + 5];
    } else if (marker === 0xda) {                   // SOS — pixel data begins
      break;
    }
    i += 2 + len;
  }
  info.quality = estimateQuality(lumaTable);
  if (icc.length) info.colorSpace = profileIsSRGB(Buffer.concat(icc)) ? 'srgb' : 'nonsrgb';
  return info;
}

// Read the Orientation tag (0x0112) from an EXIF (APP1) segment.
function readExifOrientation(buf, start, length) {
  if (buf.toString('latin1', start, start + 6) !== 'Exif\0\0') return null;
  const tiff = start + 6;
  const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > start + length) return null;
  const count = u16(ifd0);
  for (let e = 0; e < count; e++) {
    const entry = ifd0 + 2 + e * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

function inspectPng(buf) {
  const info = { format: 'png', width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20), components: 3, orientation: 1,
    quality: null, colorSpace: 'srgb' };
  let p = 8;
  while (p < buf.length - 8) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'sRGB') { info.colorSpace = 'srgb'; return info; }
    if (type === 'iCCP') {
      let end = p + 8;
      while (end < p + 8 + len && buf[end] !== 0) end++; // profile name to null
      info.colorSpace = profileIsSRGB(buf.slice(p + 8, end)) ? 'srgb' : 'nonsrgb';
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len; // len + type + data + crc
  }
  return info;
}

function inspect(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return inspectJpeg(buf);
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) return inspectPng(buf);
  return null;
}

// Header read for the formats jpg/png parsing doesn't cover (webp/gif/heic/tiff).
// sharp.metadata() reads container headers only — no full decode. Dimensions are
// per-frame (pageHeight) so animated strips don't inflate the megapixel check.
async function inspectSharp(buf) {
  try {
    const m = await sharp(buf, { limitInputPixels: false, animated: true }).metadata();
    const cmyk = m.space === 'cmyk';
    const nonsrgb = !cmyk && m.icc ? !profileIsSRGB(m.icc) : false;
    return {
      format: m.format, // 'webp' | 'gif' | 'tiff' | 'heif'
      width: m.width,
      height: m.pageHeight || m.height,
      components: m.channels,
      orientation: 1, // sharp auto-orients on decode
      quality: null,
      colorSpace: cmyk ? 'cmyk' : (nonsrgb ? 'nonsrgb' : 'srgb'),
      animated: (m.pages || 1) > 1,
    };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// sharp processing (clean RGB only)
// ---------------------------------------------------------------------------

const LOSSY = new Set(['jpeg', 'webp', 'tiff', 'heif']);

// Prebuilt libvips decodes HEIC but often can't ENCODE it (HEVC/x265 excluded
// for licensing). Probe once so oversized HEICs are flagged, not shipped broken.
let heifEncodable = null;
async function canEncodeHeif() {
  if (heifEncodable === null) {
    try {
      await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } })
        .heif({ compression: 'hevc' }).toBuffer();
      heifEncodable = true;
    } catch { heifEncodable = false; }
  }
  return heifEncodable;
}

// Fresh source-decoded pipeline at `scale` of the original, in the source
// format. .rotate() bakes EXIF orientation into pixels; sharp shrink-on-load
// means a downscale never inflates the full image in RAM. Animated gif/webp
// open with { animated: true } and resize by width so every frame scales; they
// skip .rotate() (no EXIF, and auto-orient doesn't apply to multi-frame).
function makePipe(buf, info, scale) {
  const opts = { limitInputPixels: false };
  if (info.animated) opts.animated = true;
  let p = sharp(buf, opts);
  if (!info.animated) p = p.rotate();
  if (scale < 1) p = p.resize({ width: Math.max(1, Math.round(info.width * scale)) });
  return p;
}

// Apply the source-format encoder at quality q (ignored by lossless png/gif).
function encode(pipe, info, q) {
  switch (info.format) {
    case 'png': return pipe.png();
    case 'gif': return pipe.gif();
    case 'webp': return pipe.webp({ quality: q });
    case 'tiff': return pipe.tiff({ quality: q, compression: 'jpeg' });
    case 'heif': return pipe.heif({ quality: q, compression: 'hevc' });
    default: return pipe.jpeg({ quality: q }); // jpeg
  }
}

// Binary-search quality in [FLOOR_Q, startQ] for the best buffer <= target,
// dimensions fixed at `scale`. Lossy formats only.
async function fitQuality(buf, info, scale, startQ, target, good) {
  let lo = FLOOR_Q;
  let hi = startQ;
  let best = null;
  for (let i = 0; i < MAX_ITERS && lo <= hi; i++) {
    const q = Math.round((lo + hi) / 2);
    const b = await encode(makePipe(buf, info, scale), info, q).toBuffer();
    if (b.length <= target) {
      best = b;
      if (b.length >= good) break; // good-enough band
      lo = q + 1;
    } else {
      hi = q - 1;
    }
  }
  return best;
}

// Binary-search a downscale factor (down to PX_FLOOR) at fixed quality q for the
// largest encoding <= target. Used for png/gif, and as the JPEG/etc. last resort.
async function fitScale(buf, info, baseScale, q, target, good) {
  const pixels = info.width * info.height;
  let lo = Math.sqrt(PX_FLOOR / pixels);
  if (lo >= baseScale) return null; // floor is above our target scale — can't help
  let hi = baseScale;
  let best = null;
  for (let i = 0; i < MAX_ITERS; i++) {
    const s = (lo + hi) / 2;
    const b = await encode(makePipe(buf, info, s), info, q).toBuffer();
    if (b.length <= target) {
      best = b;
      if (b.length >= good) break;
      lo = s;
    } else {
      hi = s;
    }
  }
  return best;
}

// Process a clean image buffer that breached a limit. Returns the output buffer.
async function processImage(buf, info) {
  if (info.format === 'heif' && !(await canEncodeHeif())) {
    throw new Error('over Shopify limits, and this build cannot re-encode HEIC — shrink or convert manually');
  }

  const pixels = info.width * info.height;
  const baseScale = pixels > PX_LIMIT ? Math.sqrt(PX_TARGET / pixels) : 1;
  const startQ = info.quality ? Math.max(FLOOR_Q, info.quality - 10) : FALLBACK_Q;

  let out = await encode(makePipe(buf, info, baseScale), info, startQ).toBuffer();
  if (out.length <= SIZE_LIMIT) return { buf: out, over: false };

  if (LOSSY.has(info.format)) {
    const fit = await fitQuality(buf, info, baseScale, startQ, SIZE_TARGET, SIZE_GOOD);
    if (fit) return { buf: fit, over: false };
    // Even FLOOR_Q too big — shrink dimensions at FLOOR_Q.
    const scaled = await fitScale(buf, info, baseScale, FLOOR_Q, SIZE_TARGET, SIZE_GOOD);
    return { buf: scaled || out, over: !scaled };
  }

  // Lossless (png/gif) — shrink dimensions only.
  const scaled = await fitScale(buf, info, baseScale, startQ, SIZE_TARGET, SIZE_GOOD);
  return { buf: scaled || out, over: !scaled };
}

// ---------------------------------------------------------------------------
// Filesystem: scan, mirror, output folders
// ---------------------------------------------------------------------------

function walk(root, rel, out) {
  const dir = path.join(root, rel);
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue; // skip dotfiles/dotdirs (junk, .DS_Store)
    const childRel = path.join(rel, name);
    const st = fs.statSync(path.join(root, childRel));
    if (st.isDirectory()) {
      if (rel === '' && SKIP_DIR.test(name)) continue; // don't re-ingest our output
      walk(root, childRel, out);
    } else if (st.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}

function pickFolder(root, base) {
  let name = base;
  for (let n = 1; fs.existsSync(path.join(root, name)); n++) name = `${base}-${n}`;
  return path.join(root, name);
}

function writeMirrored(destRoot, rel, buf) {
  const dest = path.join(destRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const arg = process.argv[2];
  if (arg === '-h' || arg === '--help') { usage(); return; }

  const root = path.resolve(arg || '.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`stk img: not a folder: ${root}`);
    process.exit(1);
  }

  const files = walk(root, '', []);
  if (files.length === 0) { console.log('stk img: no files to process.'); return; }

  // Resolve output folder names up front (collision -> -N); create lazily.
  const dest = {
    ready: pickFolder(root, OUT.ready),
    cmyk: pickFolder(root, OUT.cmyk),
    color: pickFolder(root, OUT.color),
  };

  const tally = { verbatim: 0, resized: 0, reduced: 0, cmyk: 0, color: 0, over: [] };

  const imgs = files.filter((rel) => IMG_EXT.test(rel));

  let n = 0;
  for (const rel of imgs) {
    n++;
    const tag = `[${n}/${imgs.length}] ${rel}`;

    const abs = path.join(root, rel);
    const buf = fs.readFileSync(abs);

    const info = inspect(buf) || await inspectSharp(buf);
    if (!info) { progress(`${tag} — skipped (not a readable image)`); continue; }

    const isCmyk = info.colorSpace === 'cmyk' || (info.format === 'jpeg' && info.components === 4);
    if (isCmyk) {
      writeMirrored(dest.cmyk, rel, buf); tally.cmyk++; progress(`${tag} — cmyk`); continue;
    }
    if (info.colorSpace === 'nonsrgb') {
      writeMirrored(dest.color, rel, buf); tally.color++; progress(`${tag} — color-check`); continue;
    }

    const overPx = info.width * info.height > PX_LIMIT;
    const overBytes = buf.length > SIZE_LIMIT;
    if (!overPx && !overBytes) {
      writeMirrored(dest.ready, rel, buf); tally.verbatim++; progress(`${tag} — copied`); continue;
    }

    const startMB = (buf.length / MB).toFixed(1);
    const job = overPx ? 'downscaling' : 'compressing';
    progress(`${tag} — ${job}…`, true); // no newline; heavy encode follows
    try {
      const res = await processImage(buf, info);
      writeMirrored(dest.ready, rel, res.buf);
      if (overPx) tally.resized++; else tally.reduced++;
      if (res.over) tally.over.push(rel);
      const endMB = (res.buf.length / MB).toFixed(1);
      progress(res.over ? ` still over 20MB (${startMB}MB)` : ` ${startMB}MB -> ${endMB}MB`);
    } catch (e) {
      writeMirrored(dest.ready, rel, buf); // couldn't process — ship original + flag
      tally.verbatim++;
      tally.over.push(`${rel} (process failed: ${e.message})`);
      progress(` failed (${e.message})`);
    }
  }

  report(dest, tally);
}

// Per-file progress to stderr; report() keeps stdout clean. `inline` omits the
// newline so a heavy encode's result can be appended to its "…" line.
function progress(msg, inline) {
  process.stderr.write(inline ? msg : `${msg}\n`);
}

function report(dest, t) {
  const rel = (p) => path.relative(process.cwd(), p) || '.';
  const readyTotal = t.verbatim + t.resized + t.reduced;
  const bits = [];
  if (t.resized) bits.push(`${t.resized} downscaled`);
  if (t.reduced) bits.push(`${t.reduced} compressed`);
  bits.push(`${t.verbatim} copied as-is`);
  console.log(`${rel(dest.ready)}/  ${readyTotal} files (${bits.join(', ')})`);
  if (t.cmyk) console.log(`${rel(dest.cmyk)}/  ${t.cmyk} images — Shopify expects RGB; convert to sRGB before upload`);
  if (t.color) console.log(`${rel(dest.color)}/  ${t.color} images — non-sRGB profile, colors will shift on Shopify; convert to sRGB`);
  if (t.over.length) {
    console.log(`\nStill over 20MB after max reduction (handle manually):`);
    for (const f of t.over) console.log(`  ${f}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`stk img: ${e.message}`); process.exit(1); });
} else {
  module.exports = { inspect, estimateQuality, processImage };
}
