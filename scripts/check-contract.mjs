#!/usr/bin/env node
// Design-contract checker. No deps. Run: node scripts/check-contract.mjs
// Fails on the drift modes that are invisible at runtime: an undefined CSS custom
// property renders as nothing, it does not throw.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const TOKENS = join(SRC, 'styles', 'tokens.css');

const walk = (dir, out = []) => {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const files = walk(SRC).filter((f) => /\.(ts|tsx|css)$/.test(f));
const rel = (f) => relative(ROOT, f).split(sep).join('/');
const isTokens = (f) => f === TOKENS;

const problems = [];
const fail = (file, line, rule, msg) =>
  problems.push({ file: rel(file), line, rule, msg });

// ---------------------------------------------------------------- tokens.css
let tokensCss = '';
try { tokensCss = readFileSync(TOKENS, 'utf8'); }
catch { console.error('FATAL: src/styles/tokens.css not found'); process.exit(2); }

const defined = new Set([...tokensCss.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]));

for (const theme of ['signal', 'instrument', 'daylight']) {
  if (!new RegExp(`data-theme=['"]${theme}['"]`).test(tokensCss) && theme !== 'signal')
    fail(TOKENS, 0, 'theme-missing', `no [data-theme='${theme}'] block`);
}

// Every theme must define the same colour tokens, or switching theme leaves holes.
const blocks = [...tokensCss.matchAll(/(:root(?:\[data-theme=['"](\w+)['"]\])?)\s*\{([^}]*)\}/g)];
const byTheme = new Map();
for (const [, , theme, body] of blocks) {
  const name = theme || 'signal';
  const set = byTheme.get(name) || new Set();
  for (const m of body.matchAll(/(--[\w-]+)\s*:/g)) set.add(m[1]);
  byTheme.set(name, set);
}
// A token that appears in MORE THAN ONE theme block is theme-swapped and must
// appear in ALL of them; one defined only in :root is theme-invariant by intent.
// (Guessing by name prefix mis-flags --texture-* as --text-*.)
{
  const themeNames = [...byTheme.keys()];
  const seenIn = new Map();
  for (const [theme, set] of byTheme)
    for (const t of set) seenIn.set(t, (seenIn.get(t) || []).concat(theme));
  for (const [token, themes] of seenIn) {
    if (themes.length === 1) continue;
    for (const theme of themeNames)
      if (!themes.includes(theme))
        fail(TOKENS, 0, 'theme-hole', `${theme} does not define ${token} (defined in ${themes.join(', ')})`);
  }
}

// ---------------------------------------------------------------- per file
// Four directories and ONE FILE. The file is the start-up splash's 28px mark,
// which is the taskbar icon reproduced at identity scale — DESIGN.md's Three
// Uses Rule and PLAN §7.4 both carry the scoping clause, and this is the
// machine that enforces it. Deliberately the file and not the directory:
// src/splash/splash.css still fails this gate if it so much as names the
// accent, which is the property worth keeping. docs/RELEASE.md §1.12 gate 2.
const ACCENT_ALLOWED = [
  'components/timeline/', 'components/ui/', 'styles/', 'components/export/',
  'splash/graphic.ts',
];

// ------------------------------------------------------- VIDEO PIXELS, NOT UI
// The hardcoded-colour rule defends ONE thing: that interface colour comes from
// the theme token layer, so switching theme moves every surface the user looks
// at. Two sites are categorically outside that promise, and exempting them is
// not a loosening of the rule — it is the rule's own scope, stated.
//
//   1. src/lib/titleRaster.ts builds `rgba(...)` from a TitleSpec the user
//      authored, and paints it into a <canvas> that is then encoded into an
//      exported file. Those bytes leave the app. A title burned into an MP4 that
//      changed colour because the editor was in `daylight` would be a defect of
//      the first order — the file must be a function of the project, never of
//      the chrome around it.
//   2. DEFAULT_TITLE.color / .background and DEFAULT_SUBTITLE_STYLE.color are
//      the seed values of that same user data. They are '#ffffff' on '#000000'
//      because that is what a caption is on video, everywhere, and because they
//      are serialised into the .veproj and re-read on a different machine. A
//      token would resolve to nothing outside a DOM and to the wrong thing
//      inside one.
//
// Written so it CANNOT silently widen. Each entry pins BOTH a line shape and an
// exact count: a real theme colour in titleRaster.ts does not match `rgba`, and
// a fourth spec default — or a fifth rgba site — breaks the count and fails the
// gate with "stale exemption", forcing whoever added it to say which it is.
const PIXEL_COLOUR_EXEMPT = [
  {
    file: 'src/lib/titleRaster.ts',
    // The rgba() builder, its doc comment, and the two fillStyle writes it feeds.
    shape: /rgba/,
    expect: 5,
  },
  {
    file: 'src/types/model.ts',
    // Exactly the TitleSpec / SubtitleStyle default colours, nothing else in the file.
    shape: /^\s*(?:color|background):\s*'#[0-9a-fA-F]{6}',$/,
    expect: 3,
  },
];

/** Hits actually granted, per entry, so a stale exemption is a failure not a gap. */
const exemptUsed = PIXEL_COLOUR_EXEMPT.map(() => 0);

function pixelColourExempt(file, line) {
  for (let i = 0; i < PIXEL_COLOUR_EXEMPT.length; i += 1) {
    const e = PIXEL_COLOUR_EXEMPT[i];
    if (rel(file) !== e.file) continue;
    if (!e.shape.test(line)) return false;
    exemptUsed[i] += 1;
    return true;
  }
  return false;
}

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const n = i + 1;
    // strip HTML numeric entities first: &#183; is a middle dot, not a colour
    const code = line.replace(/\/\/.*$/, '').replace(/&#\w+;/g, '');

    // 1. colour literals outside tokens.css
    if (!isTokens(f) && !pixelColourExempt(f, line)) {
      if (/#[0-9a-fA-F]{3,8}\b/.test(code) && !/#[0-9a-fA-F]*[g-zG-Z]/.test(code))
        fail(f, n, 'hardcoded-colour', line.trim().slice(0, 90));
      if (/\b(rgba?|hsla?)\s*\(/.test(code))
        fail(f, n, 'hardcoded-colour', line.trim().slice(0, 90));
      if (/\boklch\s*\(/.test(code))
        fail(f, n, 'hardcoded-colour', line.trim().slice(0, 90));
    }

    // 2. undefined custom property reads — the silent killer
    for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const t = m[1];
      // local layout vars are allowed to be declared in-file
      if (!defined.has(t) && !new RegExp(`${t}\\s*:`).test(src))
        fail(f, n, 'undefined-token', `var(${t}) is defined nowhere`);
    }

    // 3. magic z-index
    const z = code.match(/z-index\s*:\s*(-?\d+)/);
    if (z && !isTokens(f)) fail(f, n, 'magic-z-index', `z-index: ${z[1]} — use the scale`);

    // 4. focus removed without replacement
    if (/outline\s*:\s*(none|0)\b/.test(code) && !/:focus-visible/.test(src))
      fail(f, n, 'focus-removed', line.trim().slice(0, 90));

    // 5. transitionend gating (motion-dependent logic)
    if (/['"]transitionend['"]/.test(code))
      fail(f, n, 'transitionend-gate', 'logic gated on transitionend — breaks reduced motion');
  });

  // 6. accent budget
  if (/var\(--accent\b/.test(src) && !ACCENT_ALLOWED.some((a) => rel(f).includes(a)))
    fail(f, 0, 'accent-budget', 'uses --accent outside the closed budget — verify against PLAN §7.4');
}

// ---------------------------------------------------------------- exemption audit
// The counts are asserted in BOTH directions. Too few means an exemption is
// stale and is now covering nothing — delete it. Too many means a new colour
// literal walked in under cover of one, which is the exact failure mode an
// exemption list has, and the whole reason these are counted rather than named.
PIXEL_COLOUR_EXEMPT.forEach((e, i) => {
  if (exemptUsed[i] === e.expect) return;
  fail(
    join(ROOT, e.file),
    0,
    'stale-exemption',
    `${e.file} was exempted for ${exemptUsed[i]} colour literal(s), not ${e.expect}. ` +
      'These are VIDEO PIXELS, not interface colour — if the new one is too, raise the count ' +
      'deliberately; if it is chrome, it is a real violation and the exemption must not cover it.',
  );
});

// ---------------------------------------------------------------- reduced motion
if (!/prefers-reduced-motion/.test(tokensCss)) {
  const anyBase = files.filter((f) => f.endsWith('.css'))
    .some((f) => /prefers-reduced-motion/.test(readFileSync(f, 'utf8')));
  if (!anyBase) fail(TOKENS, 0, 'reduced-motion', 'no prefers-reduced-motion block in any stylesheet');
}

// ---------------------------------------------------------------- report
const byRule = problems.reduce((a, p) => ((a[p.rule] ||= []).push(p), a), {});
const order = Object.keys(byRule).sort((a, b) => byRule[b].length - byRule[a].length);

if (!problems.length) {
  console.log(`contract: PASS — ${files.length} files, ${defined.size} tokens defined`);
  process.exit(0);
}
console.log(`contract: ${problems.length} problems across ${files.length} files\n`);
for (const rule of order) {
  console.log(`  ${rule} (${byRule[rule].length})`);
  for (const p of byRule[rule].slice(0, 12))
    console.log(`    ${p.file}${p.line ? ':' + p.line : ''}  ${p.msg}`);
  if (byRule[rule].length > 12) console.log(`    ... ${byRule[rule].length - 12} more`);
  console.log('');
}
process.exit(1);
