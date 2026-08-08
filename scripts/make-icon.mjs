#!/usr/bin/env node
/**
 * Draws the two marks this product ships as OS icons, and then proves it drew
 * them: build/icon.png (512), build/icon.ico and build/veproj.ico, each .ico
 * carrying seven SEPARATELY AUTHORED sizes — 16, 24, 32, 48, 64, 128, 256.
 *
 * The specification is docs/ICON.md. Every number in the two ladders below is
 * typed from its table there; where a fraction and a pixel value disagreed, the
 * pixel value is the one that is here, which is what ICON.md says is normative.
 *
 * The mark (ICON.md §2, direction C, "The Cut"): amber clips on stacked lanes of
 * unequal length, severed by one vertical channel of tile colour that crosses
 * every lane. Staggered bars cut by a single vertical line is a non-linear
 * editor and nothing else. The document mark is the same geometry with the
 * light moved from the content to the label: the clips go to --text-ink and the
 * accent becomes a sash down the left edge of a page.
 *
 * The mark LOSES LANES as it shrinks — three at 256/128/64, two at 48, one at 32
 * and below — because a 3.9 px gap antialiases into a smear. That is the whole
 * reason this script writes the .ico itself instead of handing electron-builder
 * one bitmap to downscale seven times, and assertion 4 below is what stops that
 * claim from quietly becoming false again.
 *
 * The seven colours are READ FROM src/styles/tokens.css (the `signal` block) and
 * converted from oklch here. tokens.css is the only file allowed to hold a
 * colour literal, and that does not stop being true because the surface is a PNG
 * — recolour the theme, re-run, and both marks follow. Assertion 8 recomputes
 * every floored contrast pair from the tokens actually read, so a theme that
 * cannot produce a legible icon fails the build instead of shipping one.
 *
 * No dependencies: PNG over zlib, DIB and ICO by hand, both read back and
 * decoded from their own bytes rather than from the writer's copy.
 *
 * Usage:
 *   node scripts/make-icon.mjs            write + verify   (this is `npm run icon`)
 *   node scripts/make-icon.mjs --proof    also write build/icon-proof/** (23 files)
 */

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOKENS = path.join(ROOT, 'src', 'styles', 'tokens.css');
const OUT_DIR = path.join(ROOT, 'build');
const PROOF_DIR = path.join(OUT_DIR, 'icon-proof');

const WANT_PROOF = process.argv.includes('--proof');

/** The .ico ladder, ascending. Seven entries, no more and no fewer. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Supersample factor. Coverage in, antialiasing out; §3 assumes 8. */
const SS = 8;
/** countNear tolerance, per channel. Assertion 9 is the precondition for it. */
const TOL = 24;
/** The two shells an icon is actually seen against (§5). */
const SHELL_LIGHT = [0xff, 0xff, 0xff];
const SHELL_DARK = [0x20, 0x20, 0x20];

/* ------------------------------------------------------------------ colour */

const TOKEN_NAMES = {
  well: '--surface-well',
  accent: '--accent',
  panel: '--surface-panel',
  raised: '--surface-raised',
  keyline: '--border-structural',
  ink: '--text-ink',
  onAccent: '--text-on-accent',
};

/** Pulls `--name: oklch(L C H)` out of the signal (:root) block of tokens.css. */
function readToken(css, name) {
  const block = css.slice(0, css.indexOf("[data-theme='instrument']"));
  const m = new RegExp(`${name}\\s*:\\s*oklch\\(([^)]+)\\)`).exec(block);
  if (!m) throw new Error(`make-icon: ${name} not found as an oklch value in tokens.css`);
  const [L, C, H] = m[1].trim().split(/[\s/]+/).map(Number);
  if (![L, C, H].every((n) => Number.isFinite(n)))
    throw new Error(`make-icon: could not parse ${name}: oklch(${m[1]})`);
  return { L, C, H };
}

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** oklch -> linear sRGB -> gamma-encoded 8-bit sRGB. Björn Ottosson's matrices. */
function oklchToRgb({ L, C, H }) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => {
    const c = clamp01(v);
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(clamp01(srgb) * 255);
  });
}

const channelLum = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = (c) =>
  0.2126 * channelLum(c[0]) + 0.7152 * channelLum(c[1]) + 0.0722 * channelLum(c[2]);

/** WCAG 2.x relative-luminance contrast ratio, >= 1. */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const maxChannelDelta = (a, b) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/* ------------------------------------------------------------------ ladders
   ICON.md §3 and §4. These are transcriptions, not derivations. */

/** Lane spans in laneRunW / mark-run space, by lane count. Every span straddles cutAt. */
const SPANS = {
  3: [
    [0, 0.78],
    [0.16, 1.0],
    [0, 0.62],
  ],
  2: [
    [0, 0.82],
    [0.14, 1.0],
  ],
  1: [[0, 1.0]],
};

/* §3, the application mark. 512 is the 256 row at 2x — the same fractions, drawn
   at 512, not upscaled from it. It is the cross-platform fallback PNG only. */
const APP = {
  512: { margin: 24, tileW: 464, tileR: 92.8, lanes: 3, inset: 0.105, laneH: 80, pitch: 122.2, clipR: 7.2, cutW: 52, cutAt: 0.4, cutX: 194 },
  256: { margin: 12, tileW: 232, tileR: 46.4, lanes: 3, inset: 0.105, laneH: 40, pitch: 61.1, clipR: 3.6, cutW: 26, cutAt: 0.4, cutX: 97 },
  128: { margin: 6, tileW: 116, tileR: 23.2, lanes: 3, inset: 0.105, laneH: 20, pitch: 30.5, clipR: 1.8, cutW: 13, cutAt: 0.4, cutX: 49 },
  64: { margin: 3, tileW: 58, tileR: 11.6, lanes: 3, inset: 0.1, laneH: 11, pitch: 15.5, clipR: 1.0, cutW: 6, cutAt: 0.4, cutX: 24 },
  48: { margin: 2, tileW: 44, tileR: 8.4, lanes: 2, inset: 0.095, laneH: 13, pitch: 17.8, clipR: 0.8, cutW: 6, cutAt: 0.38, cutX: 17 },
  32: { margin: 1, tileW: 30, tileR: 5.7, lanes: 1, inset: 0.07, laneH: 15, pitch: 0, clipR: 0, cutW: 5, cutAt: 0.33, cutX: 10 },
  24: { margin: 1, tileW: 22, tileR: 3.7, lanes: 1, inset: 0.05, laneH: 11, pitch: 0, clipR: 0, cutW: 4, cutAt: 0.34, cutX: 7 },
  16: { margin: 1, tileW: 14, tileR: 2.2, lanes: 1, inset: 0.02, laneH: 8, pitch: 0, clipR: 0, cutW: 3, cutAt: 0.35, cutX: 5 },
};

/* §4, the document mark. `label` null below 64: the glyphs are not faded, they
   are not drawn (§4, "Label dropped below 64"). 16 has no body mark at all. */
const DOC = {
  256: { pageW: 179, pageH: 225, x0: 39, y0: 16, radius: 9.8, fold: 47, sashW: 38, label: 'VE', capH: 22.0, stroke: 4.2, lanes: 3, laneH: 23, markRun: 117, cutW: 15, cutAt: 0.4 },
  128: { pageW: 90, pageH: 113, x0: 19, y0: 8, radius: 5.0, fold: 23, sashW: 19, label: 'VE', capH: 11.0, stroke: 2.1, lanes: 3, laneH: 11, markRun: 59, cutW: 8, cutAt: 0.4 },
  64: { pageW: 47, pageH: 59, x0: 9, y0: 3, radius: 2.4, fold: 12, sashW: 11, label: 'VE', capH: 6.4, stroke: 1.2, lanes: 2, laneH: 9, markRun: 28, cutW: 6, cutAt: 0.4 },
  48: { pageW: 37, pageH: 45, x0: 6, y0: 2, radius: 1.9, fold: 10, sashW: 10, label: null, lanes: 1, laneH: 14, markRun: 21, cutW: 3, cutAt: 0.35 },
  32: { pageW: 26, pageH: 31, x0: 3, y0: 1, radius: 1.3, fold: 7, sashW: 8, label: null, lanes: 1, laneH: 9, markRun: 12, cutW: 2, cutAt: 0.35 },
  24: { pageW: 20, pageH: 24, x0: 2, y0: 0, radius: 1.1, fold: 6, sashW: 7, label: null, lanes: 1, laneH: 7, markRun: 9, cutW: 2, cutAt: 0.4 },
  16: { pageW: 14, pageH: 16, x0: 1, y0: 0, radius: 1.0, fold: 4, sashW: 5, label: null, lanes: 0 },
};

/* ---------------------------------------------------------------- geometry
   Half-open in both axes: a rect [l, r) x [t, b) with integer bounds covers
   whole pixels exactly, which is what keeps lane tops and cut edges crisp. */

function inRR(x, y, l, t, r, b, rr) {
  if (x < l || x >= r || y < t || y >= b) return false;
  if (!(rr > 0)) return true;
  const dx = x < l + rr ? l + rr - x : x > r - rr ? x - (r - rr) : 0;
  const dy = y < t + rr ? t + rr - y : y > b - rr ? y - (b - rr) : 0;
  return dx * dx + dy * dy <= rr * rr;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = wx - t * vx;
  const dy = wy - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The lane block, shared by both marks: n clips on a pitch, cut by one channel. */
function laneBlock({ count, laneH, pitch, runX0, runW, top, cutX, cutW }) {
  const spans = SPANS[count];
  const clips = spans.map(([a, b], i) => ({
    left: Math.round(runX0 + a * runW),
    right: Math.round(runX0 + b * runW),
    top: Math.round(top + i * pitch),
    bottom: Math.round(top + i * pitch) + laneH,
  }));
  return {
    clips,
    cut: { x: cutX, w: cutW, top: clips[0].top, bottom: clips[clips.length - 1].bottom },
  };
}

function appGeom(size) {
  const row = APP[size];
  const { margin, tileW, lanes, inset, laneH, pitch, cutW, cutX } = row;
  const runW = Math.round(tileW * (1 - 2 * inset));
  const runX0 = Math.round(margin + inset * tileW);
  const blockH = (lanes - 1) * pitch + laneH;
  const block = laneBlock({
    count: lanes,
    laneH,
    pitch,
    runX0,
    runW,
    top: Math.round((size - blockH) / 2),
    cutX,
    cutW,
  });
  return {
    ...row,
    size,
    runW,
    runX0,
    tile: { l: margin, t: margin, r: margin + tileW, b: margin + tileW, rr: row.tileR },
    ...block,
  };
}

function docGeom(size) {
  const row = DOC[size];
  const { pageW, pageH, x0, y0, radius, fold, sashW, lanes } = row;
  const page = { l: x0, t: y0, r: x0 + pageW, b: y0 + pageH, rr: radius };
  const body = { l: x0 + 1, t: y0 + 1, r: x0 + pageW - 1, b: y0 + pageH - 1, rr: Math.max(radius - 1, 0) };
  const g = {
    ...row,
    size,
    page,
    body,
    sash: { l: body.l, r: body.l + sashW },
    foldKeyline: size >= 32,
  };
  if (lanes > 0) {
    const markH = Math.round(0.46 * pageH);
    const pitch = markH / lanes;
    const pad = Math.round(0.06 * pageW);
    const runX0 = body.l + sashW + pad;
    const runW = row.markRun;
    const cutX = Math.round(runX0 + row.cutAt * runW - row.cutW / 2);
    Object.assign(g, {
      markH,
      pitch,
      pad,
      runX0,
      runW,
      cutX,
      ...laneBlock({
        count: lanes,
        laneH: row.laneH,
        pitch,
        runX0,
        runW,
        top: Math.round(body.t + (pageH - 2 - markH) / 2),
        cutX,
        cutW: row.cutW,
      }),
    });
  }
  if (row.label) {
    // Cap height runs ACROSS the sash; the word runs UP the page. W is the
    // advance, s the stroke, 0.30 W the letter gap (§4, glyph construction).
    const H = row.capH;
    const W = 0.7 * H;
    const s = 0.19 * H;
    const runLen = row.label.length * W + (row.label.length - 1) * 0.3 * W;
    const bottom = (body.t + body.b) / 2 + runLen / 2;
    g.glyphs = row.label.split('').map((ch, i) => ({
      ch,
      H,
      W,
      s,
      sxL: g.sash.l + (sashW - H) / 2,
      by: bottom - i * 1.3 * W,
    }));
  }
  return g;
}

/* ---------------------------------------------------------------- painting */

/** One authored bitmap. `rgba` is straight (non-premultiplied) RGBA, top-down. */
function rasterise(w, h, sample) {
  const rgba = Buffer.alloc(w * h * 4);
  const n = SS * SS;
  for (let py = 0; py < h; py += 1) {
    for (let px = 0; px < w; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cov = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        const y = py + (sy + 0.5) / SS;
        for (let sx = 0; sx < SS; sx += 1) {
          const c = sample(px + (sx + 0.5) / SS, y);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          cov += 1;
        }
      }
      const o = (py * w + px) * 4;
      // Colour is averaged over COVERED samples only, so a rounded corner does
      // not bleed the transparent side's zeroes into the edge pixel.
      if (cov > 0) {
        rgba[o] = Math.round(r / cov);
        rgba[o + 1] = Math.round(g / cov);
        rgba[o + 2] = Math.round(b / cov);
      }
      rgba[o + 3] = Math.round((255 * cov) / n);
    }
  }
  return rgba;
}

function renderApp(size, t) {
  const g = appGeom(size);
  const { tile, cut, clips } = g;
  const rgba = rasterise(size, size, (x, y) => {
    if (!inRR(x, y, tile.l, tile.t, tile.r, tile.b, tile.rr)) return null;
    // The cut is painted OVER the clips, in the tile colour, so it is visible
    // only where it crosses one. In the lane gaps it has no edge of its own.
    if (x >= cut.x && x < cut.x + cut.w && y >= cut.top && y < cut.bottom) return t.well;
    for (const c of clips) if (inRR(x, y, c.left, c.top, c.right, c.bottom, g.clipR)) return t.accent;
    return t.well;
  });
  return { size, rgba };
}

function renderDoc(size, t) {
  const g = docGeom(size);
  const { page, body, sash, fold } = g;
  const foldU0 = page.r - fold;
  const rgba = rasterise(size, size, (x, y) => {
    if (!inRR(x, y, page.l, page.t, page.r, page.b, page.rr)) return null;

    const u = x - foldU0;
    const v = y - page.t;
    const inCorner = u >= 0 && v >= 0 && u <= fold && v <= fold;
    if (inCorner && u > v) return null; // the fold, erased to alpha 0

    const inBody = inRR(x, y, body.l, body.t, body.r, body.b, body.rr);
    if (!inBody) return t.keyline; // the 1 px silhouette keyline

    if (inCorner) {
      // The flap: 1.19:1 on the body by design. The fold is carried by the
      // silhouette notch, which is a shape; the flap may disappear.
      if (g.foldKeyline && (v - u) / Math.SQRT2 < 1) return t.keyline;
      return t.raised;
    }

    if (x < sash.r) {
      if (g.glyphs) {
        for (const gl of g.glyphs) {
          // Rotated 90 deg CCW: page -y is glyph +x, page +x is glyph +y, so the
          // first letter lands at the bottom and the tops point left.
          if (inGlyph(gl.ch, gl.by - y, x - gl.sxL, gl.H, gl.W, gl.s)) return t.onAccent;
        }
      }
      return t.accent;
    }

    if (g.lanes > 0) {
      if (x >= g.cut.x && x < g.cut.x + g.cut.w && y >= g.cut.top && y < g.cut.bottom) return t.panel;
      for (const c of g.clips) if (x >= c.left && x < c.right && y >= c.top && y < c.bottom) return t.ink;
    }
    return t.panel;
  });
  return { size, rgba };
}

/** `E` and `V` in an upright box gx in [0,W], gy in [0,H], gy downward (§4). */
function inGlyph(ch, gx, gy, H, W, s) {
  if (gx < 0 || gx > W || gy < 0 || gy > H) return false;
  if (ch === 'E') {
    if (gx <= s || gy <= s || gy >= H - s) return true;
    return Math.abs(gy - H / 2) <= s / 2 && gx <= 0.82 * W;
  }
  if (ch === 'V') {
    const h = s / 2;
    return (
      distToSeg(gx, gy, h, 0, W / 2, H - h) <= h || distToSeg(gx, gy, W - h, 0, W / 2, H - h) <= h
    );
  }
  throw new Error(`make-icon: no glyph for '${ch}'`);
}

/* --------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const tbl = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tbl[n] = c;
  }
  return tbl;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function encodePng(rgba, w, h = w) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha

  // Filter type 0 on every scanline: keeps the encoder honest rather than clever.
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const o = y * (stride + 1);
    raw[o] = 0;
    rgba.copy(raw, o + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes a PNG this file could have written, from its bytes. All five filters. */
function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('make-icon: not a PNG payload');
  let off = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('make-icon: unexpected PNG format');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`make-icon: bad PNG filter ${f}`);
      out[y * stride + i] = v & 0xff;
    }
  }
  return { size: w, rgba: out };
}

/* --------------------------------------------------------------------- dib */

const maskStride = (w) => ((w + 31) >> 5) << 2;

/** 32-bit BGRA BITMAPINFOHEADER DIB, bottom-up, with a real 1 bpp AND mask. */
function encodeDib(rgba, size) {
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(size, 4);
  head.writeInt32LE(size * 2, 8); // colour rows + mask rows, per the ICO spec
  head.writeUInt16LE(1, 12); // planes
  head.writeUInt16LE(32, 14); // bpp
  head.writeUInt32LE(0, 16); // BI_RGB
  head.writeUInt32LE(size * size * 4, 20);

  const px = Buffer.alloc(size * size * 4);
  const stride = maskStride(size);
  const mask = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const sy = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x += 1) {
      const s = (sy * size + x) * 4;
      const d = (y * size + x) * 4;
      px[d] = rgba[s + 2];
      px[d + 1] = rgba[s + 1];
      px[d + 2] = rgba[s];
      px[d + 3] = rgba[s + 3];
      // The mask is derived from alpha, not written as zeroes: 32 bpp alpha is
      // authoritative on Windows 10/11, but older paths still read the mask and
      // a wrong one shows as a black box.
      if (rgba[s + 3] < 128) mask[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, px, mask]);
}

function decodeDib(buf) {
  const w = buf.readInt32LE(4);
  const h = buf.readInt32LE(8) / 2;
  if (buf.readUInt16LE(14) !== 32) throw new Error('make-icon: DIB entry is not 32 bpp');
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy = h - 1 - y;
    for (let x = 0; x < w; x += 1) {
      const s = 40 + (sy * w + x) * 4;
      const d = (y * w + x) * 4;
      out[d] = buf[s + 2];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s];
      out[d + 3] = buf[s + 3];
    }
  }
  return { size: w, rgba: out, declaredW: w, declaredH: h };
}

/* --------------------------------------------------------------------- ico */

/** 16..128 stay DIB so GDI+ can read them; 256 is PNG, which GDI+ cannot address
    at any encoding and which costs 270 KB as a DIB (§6). */
const payloadKind = (size) => (size === 256 ? 'PNG' : 'DIB');

function writeIco(images, file) {
  const payloads = images.map((b) =>
    payloadKind(b.size) === 'PNG' ? encodePng(b.rgba, b.size) : encodeDib(b.rgba, b.size),
  );
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((b, i) => {
    const o = 6 + 16 * i;
    dir[o] = b.size === 256 ? 0 : b.size;
    dir[o + 1] = b.size === 256 ? 0 : b.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(payloads[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += payloads[i].length;
  });
  const buf = Buffer.concat([dir, ...payloads]);
  writeFileSync(file, buf);
  return buf;
}

/** Parses a written .ico back from bytes. Never reuses the writer's state. */
function inspectIco(file) {
  const buf = readFileSync(file);
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const o = 6 + 16 * i;
    const declared = buf[o] === 0 ? 256 : buf[o];
    const bytes = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);
    const payload = buf.subarray(offset, offset + bytes);
    const isPng = payload.subarray(0, 8).equals(PNG_SIG);
    const bmp = isPng ? decodePng(payload) : decodeDib(payload);
    entries.push({
      declared,
      actual: bmp.size,
      kind: isPng ? 'PNG' : 'DIB',
      bytes,
      offset,
      bmp: { size: bmp.size, rgba: bmp.rgba },
    });
  }
  return { entries, total: buf.length, count, reserved: buf.readUInt16LE(0), type: buf.readUInt16LE(2) };
}

/* ------------------------------------------------------------------ probes */

const at = (bmp, x, y) => {
  const o = (y * bmp.size + x) * 4;
  return [bmp.rgba[o], bmp.rgba[o + 1], bmp.rgba[o + 2], bmp.rgba[o + 3]];
};

/** Counts opaque pixels within `tol` of `colour`. The degrade probe. */
function countNear(bmp, colour, tol = TOL) {
  let n = 0;
  for (let i = 0; i < bmp.size * bmp.size; i += 1) {
    const o = i * 4;
    if (bmp.rgba[o + 3] < 128) continue;
    if (
      Math.abs(bmp.rgba[o] - colour[0]) <= tol &&
      Math.abs(bmp.rgba[o + 1] - colour[1]) <= tol &&
      Math.abs(bmp.rgba[o + 2] - colour[2]) <= tol
    )
      n += 1;
  }
  return n;
}

/** Rows carrying at least one pixel of `colour`, collapsed into contiguous bands. */
function clipRows(bmp, colour, tol = TOL) {
  let bands = 0;
  let prev = false;
  for (let y = 0; y < bmp.size; y += 1) {
    let hit = false;
    for (let x = 0; x < bmp.size && !hit; x += 1) {
      const p = at(bmp, x, y);
      hit = p[3] >= 128 && maxChannelDelta(p, colour) <= tol;
    }
    if (hit && !prev) bands += 1;
    prev = hit;
  }
  return bands;
}

/** Box-downsamples a decoded entry to `to` px, area-weighted, alpha-aware. */
function boxDown(bmp, to) {
  const from = bmp.size;
  const scale = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y += 1) {
    for (let x = 0; x < to; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      let n = 0;
      const y0 = Math.floor(y * scale);
      const y1 = Math.min(from, Math.ceil((y + 1) * scale));
      const x0 = Math.floor(x * scale);
      const x1 = Math.min(from, Math.ceil((x + 1) * scale));
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const o = (sy * from + sx) * 4;
          const al = bmp.rgba[o + 3];
          r += bmp.rgba[o] * al;
          g += bmp.rgba[o + 1] * al;
          b += bmp.rgba[o + 2] * al;
          a += al;
          wsum += al;
          n += 1;
        }
      }
      const o = (y * to + x) * 4;
      if (wsum > 0) {
        out[o] = Math.round(r / wsum);
        out[o + 1] = Math.round(g / wsum);
        out[o + 2] = Math.round(b / wsum);
      }
      out[o + 3] = Math.round(a / (n || 1));
    }
  }
  return { size: to, rgba: out };
}

/** Fraction of pixels where either is opaque and the two differ by > 24 anywhere. */
function differs(a, b) {
  let n = 0;
  const total = a.size * a.size;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (a.rgba[o + 3] < 128 && b.rgba[o + 3] < 128) continue;
    for (let c = 0; c < 4; c += 1)
      if (Math.abs(a.rgba[o + c] - b.rgba[o + c]) > 24) {
        n += 1;
        break;
      }
  }
  return n / total;
}

/** Contiguous run of `colour` ending immediately left of `x`, and starting at `x`. */
function runLeft(bmp, x, y, colour, tol = TOL) {
  let n = 0;
  for (let i = x - 1; i >= 0; i -= 1) {
    const p = at(bmp, i, y);
    if (p[3] < 128 || maxChannelDelta(p, colour) > tol) break;
    n += 1;
  }
  return n;
}
function runRight(bmp, x, y, colour, tol = TOL) {
  let n = 0;
  for (let i = x; i < bmp.size; i += 1) {
    const p = at(bmp, i, y);
    if (p[3] < 128 || maxChannelDelta(p, colour) > tol) break;
    n += 1;
  }
  return n;
}

/* -------------------------------------------------------------- assertions */

const failures = [];
let checks = 0;

function check(ok, label, measured, floor) {
  checks += 1;
  const line = `    ${ok ? 'pass' : 'FAIL'}  ${label.padEnd(52)} ${measured}${floor ? `   (${floor})` : ''}`;
  console.log(line);
  if (!ok) failures.push(`${label}: ${measured} ${floor ? `— required ${floor}` : ''}`);
}

/* ------------------------------------------------------------------ proofs */

function nearest(bmp, scale) {
  const s = bmp.size * scale;
  const out = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y += 1)
    for (let x = 0; x < s; x += 1) {
      const so = (Math.floor(y / scale) * bmp.size + Math.floor(x / scale)) * 4;
      const o = (y * s + x) * 4;
      out[o] = bmp.rgba[so];
      out[o + 1] = bmp.rgba[so + 1];
      out[o + 2] = bmp.rgba[so + 2];
      out[o + 3] = bmp.rgba[so + 3];
    }
  return { size: s, rgba: out };
}

/** Ladder laid out left to right, largest first, bottom-aligned. */
function strip(bitmaps, scale, gap, bg) {
  const scaled = bitmaps.map((b) => (scale === 1 ? b : nearest(b, scale)));
  const w = scaled.reduce((s, b) => s + b.size, 0) + gap * (scaled.length + 1);
  const h = scaled[0].size + gap * 2;
  const out = Buffer.alloc(w * h * 4);
  if (bg)
    for (let i = 0; i < w * h; i += 1) {
      out[i * 4] = bg[0];
      out[i * 4 + 1] = bg[1];
      out[i * 4 + 2] = bg[2];
      out[i * 4 + 3] = 255;
    }
  let x = gap;
  for (const b of scaled) {
    const y0 = h - gap - b.size;
    for (let y = 0; y < b.size; y += 1)
      for (let sx = 0; sx < b.size; sx += 1) {
        const s = (y * b.size + sx) * 4;
        const d = ((y0 + y) * w + x + sx) * 4;
        const a = b.rgba[s + 3] / 255;
        for (let c = 0; c < 3; c += 1) out[d + c] = Math.round(b.rgba[s + c] * a + out[d + c] * (1 - a));
        out[d + 3] = Math.max(out[d + 3], b.rgba[s + 3]);
      }
    x += b.size + gap;
  }
  return encodePng(out, w, h);
}

/* --------------------------------------------------------------------- run */

const css = readFileSync(TOKENS, 'utf8');
const T = Object.fromEntries(
  Object.entries(TOKEN_NAMES).map(([k, name]) => [k, oklchToRgb(readToken(css, name))]),
);

console.log('make-icon: tokens read from src/styles/tokens.css (:root, signal)');
for (const [k, name] of Object.entries(TOKEN_NAMES)) console.log(`    ${name.padEnd(20)} ${hex(T[k])}  (${k})`);

mkdirSync(OUT_DIR, { recursive: true });

const appBitmaps = SIZES.map((s) => renderApp(s, T));
const docBitmaps = SIZES.map((s) => renderDoc(s, T));

const png512 = encodePng(renderApp(512, T).rgba, 512);
writeFileSync(path.join(OUT_DIR, 'icon.png'), png512);
const appIco = writeIco(appBitmaps, path.join(OUT_DIR, 'icon.ico'));
const docIco = writeIco(docBitmaps, path.join(OUT_DIR, 'veproj.ico'));

console.log(
  `\nmake-icon: wrote build/icon.png (512, ${(png512.length / 1024).toFixed(1)} KB), ` +
    `build/icon.ico (${(appIco.length / 1024).toFixed(1)} KB), ` +
    `build/veproj.ico (${(docIco.length / 1024).toFixed(1)} KB)`,
);

/* --- 1, 2, 3: the container ---------------------------------------------- */

const files = [
  { name: 'build/icon.ico', file: path.join(OUT_DIR, 'icon.ico'), geom: appGeom, clip: T.accent },
  { name: 'build/veproj.ico', file: path.join(OUT_DIR, 'veproj.ico'), geom: docGeom, clip: T.ink },
];

const read = {};
for (const f of files) {
  const ico = inspectIco(f.file);
  read[f.name] = ico;
  console.log(`\n  ${f.name} — ${ico.entries.length} entries, ${ico.total} bytes`);
  console.log('    declared  actual  kind  bytes    offset');
  for (const e of ico.entries)
    console.log(
      `    ${String(e.declared).padStart(8)}  ${String(e.actual).padStart(6)}  ${e.kind}   ${String(e.bytes).padStart(6)}   ${String(e.offset).padStart(7)}`,
    );

  console.log(`\n  1 — seven entries, ascending, exactly ${SIZES.join('/')}`);
  check(
    ico.entries.length === 7 && ico.entries.every((e, i) => e.declared === SIZES[i]),
    `${f.name} declared sizes`,
    `[${ico.entries.map((e) => e.declared).join(',')}]`,
    `[${SIZES.join(',')}]`,
  );

  console.log('  2 — the payload header agrees with the directory');
  for (const e of ico.entries)
    check(e.declared === e.actual, `${f.name} ${e.declared} declared === actual`, `${e.actual}`, `${e.declared}`);

  console.log('  3 — payloads tile the file with no gap and no overlap');
  let cursor = 6 + 16 * ico.entries.length;
  let tiled = ico.reserved === 0 && ico.type === 1;
  for (const e of ico.entries) {
    if (e.offset !== cursor) tiled = false;
    cursor += e.bytes;
  }
  check(tiled && cursor === ico.total, `${f.name} payload extents`, `${cursor} bytes covered`, `${ico.total}`);
}

/* --- 4: per-size authoring, by divergence -------------------------------- */

console.log('\n  4 — per-size authoring: authored vs the 256 entry downsampled');
for (const f of files) {
  const ico = read[f.name];
  const big = ico.entries.find((e) => e.declared === 256).bmp;
  for (const s of [48, 32, 16]) {
    const authored = ico.entries.find((e) => e.declared === s).bmp;
    const d = differs(authored, boxDown(big, s));
    check(d > 0.15, `${f.name} ${s} differs from downscaled 256`, d.toFixed(3), '> 0.150');
  }
}

/* --- 5: the degrade probe ------------------------------------------------ */

console.log('\n  9 — probe precondition: no other token lands inside the tolerance ball');
const MARK_TOKENS = {
  'build/icon.ico': { tokens: ['well', 'accent'], adjacent: [['well', 'accent']] },
  'build/veproj.ico': {
    tokens: ['keyline', 'panel', 'raised', 'accent', 'onAccent', 'ink'],
    adjacent: [
      ['keyline', 'panel'],
      ['keyline', 'raised'],
      ['panel', 'raised'],
      ['panel', 'accent'],
      ['panel', 'ink'],
      ['accent', 'onAccent'],
    ],
  },
};
const PROBES = { 'build/icon.ico': ['accent'], 'build/veproj.ico': ['onAccent', 'accent', 'ink'] };
for (const f of files) {
  const { tokens, adjacent } = MARK_TOKENS[f.name];
  for (const p of PROBES[f.name])
    for (const q of tokens) {
      if (q === p) continue;
      const isAdj = adjacent.some(([a, b]) => (a === p && b === q) || (a === q && b === p));
      const d = maxChannelDelta(T[p], T[q]);
      const floor = isAdj ? 2 * TOL : TOL;
      check(d > floor, `${TOKEN_NAMES[p]} vs ${TOKEN_NAMES[q]}${isAdj ? ' (adjacent)' : ''}`, `${d}`, `> ${floor}`);
    }
}

console.log('\n  5 — the degrade probe: token-coloured pixels per decoded entry');
const LABEL_FLOOR = { 256: 100, 128: 20, 64: 4, 48: 0, 32: 0, 24: 0, 16: 0 };
const INK_ZERO = 16;
const CLIP_ROWS = { 256: 3, 128: 3, 64: 3, 48: 2, 32: 1, 24: 1, 16: 1 };

for (const e of read['build/veproj.ico'].entries) {
  const n = countNear(e.bmp, T.onAccent);
  const floor = LABEL_FLOOR[e.declared];
  check(
    floor === 0 ? n === 0 : n >= floor,
    `veproj ${e.declared} --text-on-accent (label)`,
    `${n}`,
    floor === 0 ? '= 0' : `>= ${floor}`,
  );
}
for (const e of read['build/veproj.ico'].entries)
  check(countNear(e.bmp, T.accent) > 0, `veproj ${e.declared} --accent (sash)`, `${countNear(e.bmp, T.accent)}`, '> 0');
for (const e of read['build/veproj.ico'].entries) {
  const n = countNear(e.bmp, T.ink);
  const want0 = e.declared === INK_ZERO;
  check(want0 ? n === 0 : n > 0, `veproj ${e.declared} --text-ink (mark)`, `${n}`, want0 ? '= 0' : '> 0');
}
for (const e of read['build/icon.ico'].entries) {
  const n = clipRows(e.bmp, T.accent);
  check(n === CLIP_ROWS[e.declared], `icon ${e.declared} distinct clip rows`, `${n}`, `= ${CLIP_ROWS[e.declared]}`);
}

/* --- 6: the cut constraints ---------------------------------------------- */

console.log('\n  6 — the cut: span, width, remnant');
for (const f of files) {
  for (const e of read[f.name].entries) {
    const g = f.geom(e.declared);
    if (!g.lanes) continue;
    const spans = SPANS[g.lanes];
    check(
      spans.every(([a, b]) => a < g.cutAt && g.cutAt < b),
      `${f.name} ${e.declared} every span straddles cutAt ${g.cutAt}`,
      `[${spans.map(([a, b]) => `${a}..${b}`).join(', ')}]`,
      'a < cutAt < b',
    );
    if (g.lanes >= 2) {
      const gap = g.pitch - g.laneH;
      check(g.cutW >= gap, `${f.name} ${e.declared} cutW >= lane gap`, `${g.cutW}`, `>= ${gap.toFixed(1)}`);
    }
    let worst = Infinity;
    for (const c of g.clips) {
      const y = Math.floor((c.top + c.bottom) / 2);
      worst = Math.min(worst, runLeft(e.bmp, g.cut.x, y, f.clip), runRight(e.bmp, g.cut.x + g.cut.w, y, f.clip));
    }
    check(worst >= 3, `${f.name} ${e.declared} smallest clip fragment`, `${worst} px`, '>= 3 px');
  }
}

/* --- 7: silhouette, notch and sash --------------------------------------- */

console.log('\n  7 — silhouette, notch and sash');
for (const f of files)
  for (const e of read[f.name].entries) {
    const s = e.bmp.size - 1;
    const corners = [at(e.bmp, 0, 0)[3], at(e.bmp, s, 0)[3], at(e.bmp, 0, s)[3], at(e.bmp, s, s)[3]];
    check(corners.every((a) => a === 0), `${f.name} ${e.declared} corner alpha`, `[${corners.join(',')}]`, 'all 0');
  }
for (const e of read['build/veproj.ico'].entries) {
  const g = docGeom(e.declared);
  let clear = 0;
  for (let y = g.page.t; y < g.page.b; y += 1)
    for (let x = g.page.l; x < g.page.r; x += 1) if (at(e.bmp, x, y)[3] === 0) clear += 1;
  const floor = 0.35 * g.fold * g.fold;
  check(clear >= floor, `veproj ${e.declared} notch, transparent px in page bbox`, `${clear}`, `>= ${floor.toFixed(1)}`);

  const y = Math.floor((g.body.t + g.body.b) / 2);
  let extent = 0;
  for (let x = g.body.l; x < g.body.r; x += 1) {
    const p = at(e.bmp, x, y);
    const isSash =
      p[3] >= 128 && (maxChannelDelta(p, T.accent) <= TOL || maxChannelDelta(p, T.onAccent) <= TOL);
    if (!isSash) break;
    extent += 1;
  }
  check(extent === g.sashW, `veproj ${e.declared} painted sash width`, `${extent} px`, `= ${g.sashW} px`);
}

/* --- 8: contrast, from the tokens actually read -------------------------- */

console.log('\n  8 — contrast, recomputed from the tokens read');
const GATES = [
  ['accent vs tile', T.accent, T.well, 3],
  ['tile vs #ffffff', T.well, SHELL_LIGHT, 3],
  ['accent vs #202020', T.accent, SHELL_DARK, 3],
  ['keyline vs #ffffff', T.keyline, SHELL_LIGHT, 3],
  ['keyline vs #202020', T.keyline, SHELL_DARK, 3],
  ['clips vs page body', T.ink, T.panel, 3],
  ['sash vs page body', T.accent, T.panel, 3],
  ['label vs sash', T.onAccent, T.accent, 4.5],
];
for (const [label, a, b, floor] of GATES) {
  const r = contrast(a, b);
  check(r >= floor, label, `${r.toFixed(2)} : 1`, `>= ${floor.toFixed(1)} : 1`);
}

/* --- proof renders ------------------------------------------------------- */

if (WANT_PROOF) {
  mkdirSync(PROOF_DIR, { recursive: true });
  const w = (n, buf) => writeFileSync(path.join(PROOF_DIR, n), buf);
  const desc = [...SIZES].reverse();
  const appDesc = desc.map((s) => appBitmaps[SIZES.indexOf(s)]);
  const docDesc = desc.map((s) => docBitmaps[SIZES.indexOf(s)]);

  for (const s of SIZES) {
    w(`app-${s}.png`, encodePng(appBitmaps[SIZES.indexOf(s)].rgba, s));
    w(`doc-${s}.png`, encodePng(docBitmaps[SIZES.indexOf(s)].rgba, s));
  }
  w('app-3x.png', strip(appDesc, 3, 12, null));
  w('doc-3x.png', strip(docDesc, 3, 12, null));
  w('app-8x.png', strip(appDesc, 8, 24, null));
  w('doc-8x.png', strip(docDesc, 8, 24, null));
  w('app-1to1-dark.png', strip(appDesc, 1, 10, [0x19, 0x19, 0x1c]));
  w('app-1to1-light.png', strip(appDesc, 1, 10, [0xf3, 0xf3, 0xf3]));
  w('app-1to1-mid.png', strip(appDesc, 1, 10, [0x78, 0x7c, 0x82]));
  w('doc-1to1-light.png', strip(docDesc, 1, 10, [0xff, 0xff, 0xff]));
  w('doc-1to1-dark.png', strip(docDesc, 1, 10, [0x20, 0x20, 0x22]));
  console.log(`\nmake-icon: --proof wrote 23 files into build/icon-proof/`);
}

/* --- verdict ------------------------------------------------------------- */

console.log(`\nmake-icon: ${checks - failures.length}/${checks} checks passed`);
if (failures.length) {
  console.error(`make-icon: ${failures.length} FAILED`);
  for (const f of failures) console.error(`    ${f}`);
  process.exit(1);
}
