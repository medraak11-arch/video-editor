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

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const lines = src.split('\n');

  lines.forEach((line, i) => {
    const n = i + 1;
    // strip HTML numeric entities first: &#183; is a middle dot, not a colour
    const code = line.replace(/\/\/.*$/, '').replace(/&#\w+;/g, '');

    // 1. colour literals outside tokens.css
    if (!isTokens(f)) {
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
