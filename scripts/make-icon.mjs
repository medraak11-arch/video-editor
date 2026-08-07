#!/usr/bin/env node
/**
 * Draws build/icon.png — the application mark. electron-builder converts it to
 * the .ico that becomes the installer icon, the Start-menu entry and the icon on
 * Video Editor.exe.
 *
 * The mark is one lit 16:9 frame on a near-black tile, cut by the playhead. That
 * is the whole product in two shapes: PRODUCT.md principle 1 says the frame is
 * the largest, highest-contrast element and all chrome yields to the footage, so
 * the icon is a dark tile with exactly one bright thing on it.
 *
 * The two colours are READ FROM src/styles/tokens.css (the `signal` block) and
 * converted from oklch here. tokens.css is the only file allowed to hold a
 * colour literal, and that rule does not stop being true because the surface is
 * a PNG instead of a stylesheet — recolour the theme and re-run this script and
 * the icon follows.
 *
 * No dependencies: PNG is written by hand over zlib.
 *
 * Usage: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TOKENS = path.join(ROOT, 'src', 'styles', 'tokens.css');
const OUT_DIR = path.join(ROOT, 'build');
const OUT = path.join(OUT_DIR, 'icon.png');

const SIZE = 512; // electron-builder wants >= 256; 512 gives it room to downscale
const SS = 4; // supersample factor — the only anti-aliasing in here

/* ------------------------------------------------------------------ colour */

/** Pulls `--name: oklch(L C H)` out of the signal (:root) block of tokens.css. */
function readToken(css, name) {
  const block = css.slice(0, css.indexOf("[data-theme='instrument']"));
  const m = new RegExp(`${name}\\s*:\\s*oklch\\(([^)]+)\\)`).exec(block);
  if (!m) throw new Error(`make-icon: ${name} not found as an oklch value in tokens.css`);
  const parts = m[1].trim().split(/[\s/]+/).map(Number);
  const [L, C, H] = parts;
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

  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  return lin.map((v) => {
    const c = clamp01(v);
    const srgb = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(clamp01(srgb) * 255);
  });
}

/* ------------------------------------------------------------------- shapes
   Everything is a coverage test in supersampled pixel space; the box-downsample
   at the end turns coverage into anti-aliasing. */

const inRoundedRect = (x, y, left, top, right, bottom, r) => {
  if (x < left || x > right || y < top || y > bottom) return false;
  const dx = x < left + r ? left + r - x : x > right - r ? x - (right - r) : 0;
  const dy = y < top + r ? top + r - y : y > bottom - r ? y - (bottom - r) : 0;
  return dx * dx + dy * dy <= r * r;
};

function render(shell, accent) {
  const N = SIZE * SS;
  const hi = new Uint8Array(N * N * 3);

  // Tile: a squircle-ish rounded square with a small margin, so the mark reads
  // as an icon rather than as a full-bleed swatch when the OS does not mask it.
  const pad = N * 0.045;
  const tile = { l: pad, t: pad, r: N - pad, b: N - pad, radius: N * 0.2 };

  // The lit frame: 16:9, centred, occupying most of the tile's width.
  const fw = (tile.r - tile.l) * 0.66;
  const fh = (fw * 9) / 16;
  const cx = N / 2;
  const cy = N / 2;
  const frame = {
    l: cx - fw / 2,
    t: cy - fh / 2,
    r: cx + fw / 2,
    b: cy + fh / 2,
    radius: N * 0.012,
  };

  // The playhead: a full-height bar a third of the way across, INVERTED where it
  // crosses the frame. Frame XOR playhead is what makes the two shapes read as
  // one mark instead of as a rectangle with a stripe on it, and it is the only
  // reason the icon is identifiable at 16 px.
  const phw = N * 0.016;
  const phx = frame.l + (frame.r - frame.l) * 0.34;
  const ph = {
    l: phx - phw / 2,
    t: tile.t + (tile.b - tile.t) * 0.13,
    r: phx + phw / 2,
    b: tile.b - (tile.b - tile.t) * 0.13,
    radius: phw / 2,
  };

  for (let y = 0; y < N; y += 1) {
    for (let x = 0; x < N; x += 1) {
      if (!inRoundedRect(x, y, tile.l, tile.t, tile.r, tile.b, tile.radius)) continue; // transparent
      const inFrame = inRoundedRect(x, y, frame.l, frame.t, frame.r, frame.b, frame.radius);
      const inPlayhead = inRoundedRect(x, y, ph.l, ph.t, ph.r, ph.b, ph.radius);
      const colour = inFrame !== inPlayhead ? accent : shell;
      const i = (y * N + x) * 3;
      hi[i] = colour[0];
      hi[i + 1] = colour[1];
      hi[i + 2] = colour[2];
      // alpha is a separate coverage pass below
    }
  }

  // Second pass for alpha: a pixel is opaque exactly where the tile covers it.
  const alphaHi = new Uint8Array(N * N);
  for (let y = 0; y < N; y += 1)
    for (let x = 0; x < N; x += 1)
      alphaHi[y * N + x] = inRoundedRect(x, y, tile.l, tile.t, tile.r, tile.b, tile.radius) ? 255 : 0;

  // Box downsample SS x SS. Colour is averaged over COVERED samples only, so the
  // rounded corners do not bleed black from the transparent side.
  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const hx = x * SS + sx;
          const hy = y * SS + sy;
          const ai = hy * N + hx;
          a += alphaHi[ai];
          if (alphaHi[ai] === 0) continue;
          covered += 1;
          const ci = ai * 3;
          r += hi[ci];
          g += hi[ci + 1];
          b += hi[ci + 2];
        }
      }
      const n = SS * SS;
      const o = (y * SIZE + x) * 4;
      const d = covered || 1;
      out[o] = Math.round(r / d);
      out[o + 1] = Math.round(g / d);
      out[o + 2] = Math.round(b / d);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- png */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
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

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  // 10 compression, 11 filter, 12 interlace all 0

  // Filter type 0 on every scanline: the image is tiny and this keeps the
  // encoder honest rather than clever.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const o = y * (size * 4 + 1);
    raw[o] = 0;
    rgba.copy(raw, o + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------------- main */

const css = readFileSync(TOKENS, 'utf8');
// --surface-chrome, not --surface-well: the well is oklch L=0.10, which is so
// close to black that the tile's rounded corners disappear against a dark
// taskbar. Chrome is the colour the app's own frame actually is, and it holds an
// edge. The accent still carries all of the contrast.
const shell = oklchToRgb(readToken(css, '--surface-chrome'));
const accent = oklchToRgb(readToken(css, '--accent'));

mkdirSync(OUT_DIR, { recursive: true });
const png = encodePng(render(shell, accent), SIZE);
writeFileSync(OUT, png);

const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
console.log(
  `make-icon: ${path.relative(ROOT, OUT)} — ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB, ` +
    `tile ${hex(shell)} (--surface-chrome), frame ${hex(accent)} (--accent)`,
);
