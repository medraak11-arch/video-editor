#!/usr/bin/env node
/* ---------------------------------------------------------------------------
   check-gate-failure-paths.mjs — the gate on the other gates' FAILURE paths.
   CREATIVE §7.4 entry 8.

   Run:  node scripts/check-gate-failure-paths.mjs

   Every gate in this suite is exercised constantly on its passing path and
   never on its failing one. That asymmetry hid two defects in a single
   retrofit, both on the branch that only runs when a gate has something to
   report — which is to say, the branch that matters:

     · `check-transitions` died with `ReferenceError: keepBundle is not defined`,
       because the declaration had landed inside a `finally` block and was
       block-scoped. A gate that throws a stack trace about its own explaining
       mechanism, instead of the explanation, is worse than one without it.
     · six gates preserved the bundle and never printed its path, leaving it in
       a `mkdtemp` directory with a random name — preserved and unfindable,
       which is most of the way back to not preserving it.

   BOTH SURVIVED A STRUCTURAL CHECK, and that is the reason this file exists. A
   grep for the declaration's indentation reported "top-level OK" on the file
   that provably threw — indentation is not scope. A grep for the phrase
   `preserved at:` reported "not preserved" on six gates that were preserving
   perfectly well and simply not printing. Both readings were plausible, both
   were the instrument rather than the subject, and both were settled only by
   making the branch run.

   THE FIRST VERSION OF THIS FILE HAD THE SAME DISEASE. It scored a gate as
   "reports" on exit code 1 alone — and a `SyntaxError` exits 1, so it passed
   eight gates that could not be parsed at all. It now requires the gate to be
   seen SAYING the thing it was forced to say. Exit code is not output.

   For each gate: copy the script, force one failure into it, run it, and check

     · it exits 1, AND its own report contains the forced failure text
     · nothing threw
     · a preserved-bundle path appears in the output
     · and that path EXISTS on disk — preserved AND findable, which is the
       property entry 8 is actually about.

   It costs about three seconds for the whole suite, because every gate here is
   cheap on a forced failure.
--------------------------------------------------------------------------- */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GATES = [
  'check-timeline-guards', 'check-linking', 'check-insert', 'check-srt',
  'check-grade', 'check-transitions', 'check-mix', 'check-titles', 'check-export-graph',
];

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const rows = [];

for (const gate of GATES) {
  const src = here(`./${gate}.mjs`);
  const copy = here(`./_fb_${gate}.mjs`);
  copyFileSync(src, copy);
  let text = readFileSync(copy, 'utf8');

  // Force exactly one failure, immediately before the verdict.
  const marker = /if \(failures\.length(?: > 0)?\) \{/;
  if (!marker.test(text)) {
    rows.push([gate, 'NO VERDICT BRANCH FOUND', '', '']);
    rmSync(copy, { force: true });
    continue;
  }
  text = text.replace(marker, (m) => `failures.push('FORCED — failure-branch verification');\n${m}`);
  writeFileSync(copy, text, 'utf8');

  let out = '';
  let code = 0;
  try {
    execFileSync(process.execPath, [copy], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, killSignal: 'SIGKILL',
    });
  } catch (e) {
    code = e.status ?? `killed:${e.signal}`;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  } finally {
    rmSync(copy, { force: true });
  }

  /* "exit 1" IS NOT "reported". A SyntaxError exits 1 too, and scoring that as a
     clean report is how the first run of this verifier passed eight gates that
     could not even be parsed. The gate must be seen SAYING the thing it was
     forced to say. */
  const threw = /Error\b|is not defined/.test(out);
  const reported = out.includes('FORCED — failure-branch verification');
  const pathMatch = /preserved at:\s*\r?\n\s*(\S.*?)\s*$/m.exec(out);
  const dirExists = pathMatch ? existsSync(pathMatch[1]) : false;
  if (pathMatch && dirExists) rmSync(pathMatch[1], { recursive: true, force: true });

  rows.push([
    gate,
    code === 1 && reported && !threw
      ? 'reports'
      : `BROKEN (exit ${code}${threw ? ', THREW' : ''}${reported ? '' : ', SILENT'})`,
    pathMatch ? 'prints path' : 'NO PATH',
    pathMatch ? (dirExists ? 'dir exists' : 'DIR MISSING') : '-',
  ]);
}

let bad = 0;
console.log('\nCREATIVE §7.4 entry 8 — failure branches, exercised\n');
for (const [gate, a, b, c] of rows) {
  const ok = a === 'reports' && b === 'prints path' && c === 'dir exists';
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${gate.padEnd(22)} ${a.padEnd(26)} ${b.padEnd(12)} ${c}`);
}
console.log(bad === 0 ? '\nall failure branches report cleanly and name a findable bundle\n' : `\n${bad} broken\n`);
process.exit(bad === 0 ? 0 : 1);
