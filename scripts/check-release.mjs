#!/usr/bin/env node
// Release gate — docs/RELEASE.md §1.12 gate 1. No deps.
//
//   node scripts/check-release.mjs              run every assertion
//   node scripts/check-release.mjs --write-deps rewrite electron-builder.yml's
//                                               node_modules re-inclusion block
//                                               from the resolved closure
//
// Every assertion prints its measured value beside its expectation, and the
// script exits non-zero on any failure. It catches the four drift modes that
// are invisible until a user presses a button in an installed app: a feed
// nobody chose, a feed over plain http, a version number that exists in two
// places, and an asar missing part of electron-updater's dependency graph.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep, resolve, dirname } from 'node:path';

const ROOT = process.cwd();
const rel = (p) => relative(ROOT, p).split(sep).join('/');

const failures = [];
const notes = [];
const fail = (what, expected, measured) => failures.push({ what, expected, measured });
const pass = (what, measured) => notes.push(`  ok   ${what} — ${measured}`);

/* ============================================================ tokenising ===
   Comments are stripped before three of the assertions below match, and a
   naive strip is not usable here: `'ve-media://file/'` and
   `/https:\/\/[^\s"'<>)]+/` both look like the start of a comment or a string
   to a regex. So the source is walked once, tracking string, template, comment
   and regex state, and the regex-vs-division call is made the way every
   tokeniser makes it — from the previous significant character.             */

const REGEX_CANNOT_FOLLOW = /[\w$)\]]/;

/** @returns {{ code: string, strings: string[] }} code with comments blanked. */
function tokenise(src) {
  let code = '';
  const strings = [];
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && !REGEX_CANNOT_FOLLOW.test(prev)) {
      // A regex literal. Consumed whole, including its character classes, so
      // the quotes inside one never open a string.
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') i += 2;
        else if (r === '[') (inClass = true), i++;
        else if (r === ']') (inClass = false), i++;
        else if (r === '/' && !inClass) break;
        else if (r === '\n') break;
        else i++;
      }
      i++;
      prev = '/';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let body = '';
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          body += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        body += src[i];
        i++;
      }
      i++;
      strings.push(body);
      prev = quote;
      continue;
    }
    code += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code, strings };
}

/** CSS has no regex and no template literal; comment spans are the whole job. */
const stripCssComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '');

const walk = (dir, out = []) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/* ================================================= 1–2. the publish key ==== */

const YML_PATH = join(ROOT, 'electron-builder.yml');
const yml = readFileSync(YML_PATH, 'utf8');

const publishLine = /^publish:[ \t]*(.*)$/m.exec(yml);
if (!publishLine) {
  fail(
    'electron-builder.yml declares an explicit top-level `publish:` key',
    'present — see docs/RELEASE.md §1.2',
    'absent: with no publish key electron-builder INFERS a github provider from ' +
      'the git remote and writes an app-update.yml pointing at a repository ' +
      'nobody chose. Removing that line is a bug; changing it is the release decision.',
  );
} else {
  // The block runs from the publish line to the next top-level key.
  const from = publishLine.index;
  const after = yml.slice(from + publishLine[0].length);
  const end = /^\S/m.exec(after);
  const block = after.slice(0, end ? end.index : after.length);

  // Report what is actually configured. The inline capture is empty whenever
  // publish is a BLOCK, and falling back to " null" there printed the exact
  // opposite of the truth — a gate that says "publish: null" while a github
  // provider is configured is worse than one that says nothing.
  const provider = /provider:\s*(\S+)/.exec(block);
  pass(
    'explicit top-level `publish:` key',
    publishLine[1].trim() || (provider ? `provider: ${provider[1]}` : 'block with no provider'),
  );
  if (/provider:\s*generic/.test(block)) {
    const url = /^\s*-?\s*url:\s*(\S+)/m.exec(block);
    if (!url || !url[1].startsWith('https://')) {
      fail(
        'a generic publish provider is served over https',
        'url: https://…  (§1.9 — over plain http any party on the path can ' +
          'replace both latest.yml and the .exe, and the sha512 will match ' +
          'perfectly because the attacker wrote both)',
        url ? url[1] : 'no url: key in the publish block',
      );
    } else {
      pass('generic provider url is https', url[1]);
    }
  }
}

/* ==================================================== 3. one version, semver */

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/.test(pkg.version ?? '')) {
  fail('package.json version parses as semver', 'MAJOR.MINOR.PATCH', String(pkg.version));
} else {
  pass('package.json version parses as semver', pkg.version);
}

/* ======================================= 4. no version literal anywhere else
   This is what makes "one source of truth" a gate rather than a promise
   (§2.1). Only string literals count: comments carry examples, and a regex or
   a viewBox coordinate is not a version.                                     */

const SEMVERISH = /\b\d+\.\d+\.\d+\b/;
const sources = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'electron'))].filter((f) =>
  /\.tsx?$/.test(f),
);
const literals = [];
for (const f of sources) {
  for (const s of tokenise(readFileSync(f, 'utf8')).strings) {
    if (SEMVERISH.test(s)) literals.push(`${rel(f)}: ${JSON.stringify(s)}`);
  }
}
if (literals.length) {
  fail(
    'no version literal in src/** or electron/**',
    'none — main answers with app.getVersion() and the renderer reads api.build.version',
    literals.join('\n              '),
  );
} else {
  pass('no version literal in src/** or electron/**', `${sources.length} files scanned`);
}

/* ================================= 5. the electron-builder files allow-list ==
   Re-resolved here rather than shelled out to npm: `npm ls --omit=dev --all
   --parseable electron-updater` prints ONE line, because the name filter
   defeats --all, and the unfiltered form prints this repository's whole
   production tree — react, zustand, lucide-react and the two font packages —
   which Vite bundles into dist/ and which have no business in the asar.      */

const readPkg = (dir) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
};

/** Resolve `name` from `fromDir` the way node does: walk up through successive
 *  node_modules directories. */
function resolveFrom(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const NM = join(ROOT, 'node_modules');
const start = join(NM, 'electron-updater');
/** name -> resolved directory */
const closure = new Map();
const missing = [];

if (!existsSync(start)) {
  fail(
    'electron-updater is installed',
    'node_modules/electron-updater',
    'absent — run npm install',
  );
} else {
  closure.set('electron-updater', start);
  const queue = [start];
  while (queue.length) {
    const dir = queue.shift();
    const meta = readPkg(dir);
    if (!meta) continue;
    const deps = new Set(Object.keys(meta.dependencies ?? {}));
    // optionalDependencies count only when they are actually on disk.
    for (const name of Object.keys(meta.optionalDependencies ?? {})) {
      if (resolveFrom(dir, name)) deps.add(name);
    }
    for (const name of deps) {
      const loc = resolveFrom(dir, name);
      if (!loc) {
        missing.push(`${name} (required by ${rel(dir)})`);
        continue;
      }
      if (closure.has(name)) continue;
      closure.set(name, loc);
      queue.push(loc);
    }
  }
}

const resolvedNames = [...closure.keys()].sort();
const ymlNames = [...yml.matchAll(/^\s*-\s*'node_modules\/([^/]+)\/\*\*'\s*$/gm)].map((m) => m[1]);

// The list is REGENERATED rather than edited, so it and the resolution can
// never drift by a typo. The contiguous run of glob lines is replaced whole.
if (process.argv.includes('--write-deps')) {
  const GLOB_LINE = /^\s*-\s*'node_modules\/[^/]+\/\*\*'\s*$/;
  const lines = yml.split('\n');
  const first = lines.findIndex((l) => GLOB_LINE.test(l));
  if (first === -1) {
    console.error('--write-deps: no existing node_modules re-inclusion block to replace');
    process.exit(2);
  }
  let last = first;
  while (last + 1 < lines.length && GLOB_LINE.test(lines[last + 1])) last++;
  const block = resolvedNames.map((n) => `  - 'node_modules/${n}/**'`);
  lines.splice(first, last - first + 1, ...block);
  writeFileSync(YML_PATH, lines.join('\n'), 'utf8');
  console.log(`check-release: wrote ${block.length} package globs into electron-builder.yml`);
  process.exit(0);
}

if (missing.length) {
  fail(
    "every package in electron-updater's closure resolves",
    'all of them',
    missing.join(', '),
  );
}

const ymlSet = new Set(ymlNames);
const onlyResolved = resolvedNames.filter((n) => !ymlSet.has(n));
const onlyYml = ymlNames.filter((n) => !closure.has(n));
if (onlyResolved.length || onlyYml.length) {
  fail(
    "electron-builder.yml re-includes exactly electron-updater's production closure",
    `${resolvedNames.length} packages: ${resolvedNames.join(' ')}`,
    `${ymlNames.length} in the yml: ${[...ymlNames].sort().join(' ')}\n` +
      `              missing from the yml: ${onlyResolved.join(' ') || '—'}\n` +
      `              in the yml but not resolved: ${onlyYml.join(' ') || '—'}\n` +
      '              regenerate with: node scripts/check-release.mjs --write-deps',
  );
} else if (closure.size) {
  pass('files allow-list equals the resolved closure', `${resolvedNames.length} packages`);
}

/* Coverage, which is what assertion 2 of §1.11 is actually protecting. A
   package resolved at the top level is shipped by its own `node_modules/<name>/**`
   entry. A package npm could not hoist is shipped only if it sits inside a
   directory that is itself re-included — which, for a copy nested under
   node_modules/electron-updater/, it is. Anything else would be silently
   omitted from the asar and would reproduce the exact `Cannot find module`
   this list exists to prevent. */
const nested = [];
for (const [name, dir] of closure) {
  const top = join(NM, name);
  if (resolve(dir) === resolve(top)) continue;
  const owner = /node_modules[\\/]([^\\/]+)[\\/]node_modules[\\/]/.exec(rel(dir) + '/');
  if (owner && ymlSet.has(owner[1])) {
    nested.push(`${name} under ${owner[1]}`);
    continue;
  }
  fail(
    `${name} is reachable inside the asar`,
    `node_modules/${name}, or nested inside a package the files list re-includes`,
    `${rel(dir)} — not covered by any glob. See docs/RELEASE.md §1.11's fallback.`,
  );
}
if (nested.length) {
  pass(
    'nested copies are covered by their owner’s glob',
    `${nested.length} of ${closure.size}: ${nested.join(', ')}`,
  );
}

/* ============================================ 6. the splash declares no motion
   Comments are stripped FIRST. Every CSS file in this codebase opens with a
   prose header, and splash.css's own header contains the words `transition` and
   `animation` — a word-match would fail the build on the very comment that
   explains the rule. Declarations, not words.                                */

const SPLASH_CSS = join(ROOT, 'src', 'splash', 'splash.css');
if (!existsSync(SPLASH_CSS)) {
  fail('src/splash/splash.css exists', 'present', 'absent');
} else {
  const css = stripCssComments(readFileSync(SPLASH_CSS, 'utf8'));
  const motion = [
    ...[...css.matchAll(/^\s*((?:transition|animation)[\w-]*)\s*:/gm)].map((m) => m[1]),
    ...(/@keyframes\b/.test(css) ? ['@keyframes'] : []),
  ];
  if (motion.length) {
    fail(
      'src/splash/splash.css declares no motion',
      'none — under prefers-reduced-motion nothing differs because there is nothing to reduce (§3.11)',
      motion.join(', '),
    );
  } else {
    pass('src/splash/splash.css declares no motion', 'no transition, no animation, no @keyframes');
  }
}

/* ================================ 7. exactly one quitAndInstall in the app ==
   Comments are stripped first for the same reason: update.ts names the call
   twice more, in a JSDoc block and in this file's own prose.                 */

const UPDATE_TS = join(ROOT, 'electron', 'update.ts');
if (!existsSync(UPDATE_TS)) {
  fail('electron/update.ts exists', 'present', 'absent');
} else {
  const { code } = tokenise(readFileSync(UPDATE_TS, 'utf8'));
  const count = [...code.matchAll(/\bquitAndInstall\b/g)].length;
  if (count !== 1) {
    fail(
      'electron/update.ts calls quitAndInstall exactly once',
      '1 — runUpdateInstaller() is the only exit, and it is reached only through the unsaved-changes guard (§1.8)',
      String(count),
    );
  } else {
    pass('exactly one quitAndInstall in electron/update.ts', '1');
  }
  const others = [...walk(join(ROOT, 'electron')), ...walk(join(ROOT, 'src'))]
    .filter((f) => /\.tsx?$/.test(f) && resolve(f) !== resolve(UPDATE_TS))
    .filter((f) => /\bquitAndInstall\b/.test(tokenise(readFileSync(f, 'utf8')).code));
  if (others.length) {
    fail(
      'nothing outside electron/update.ts calls quitAndInstall',
      'no other caller',
      others.map(rel).join(', '),
    );
  }
}

/* ================================================================== report = */

if (!failures.length) {
  console.log(`release: PASS`);
  for (const n of notes) console.log(n);
  process.exit(0);
}

console.log(`release: ${failures.length} problem${failures.length === 1 ? '' : 's'}\n`);
for (const f of failures) {
  console.log(`  FAIL  ${f.what}`);
  console.log(`    expected: ${f.expected}`);
  console.log(`    measured: ${f.measured}\n`);
}
process.exit(1);
