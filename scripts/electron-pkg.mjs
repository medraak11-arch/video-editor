#!/usr/bin/env node
/**
 * Writes dist-electron/package.json = {"type":"commonjs"}.
 *
 * The repo root is "type": "module" (Vite/ESM governs src/**), but the electron output is
 * CommonJS, and a preload running under contextIsolation:true + sandbox:false MUST be CJS
 * or it fails silently and leaves window.editorAPI undefined. This one-line manifest is
 * the standard, and required, way to say so. PLAN §1.2.
 *
 * dist-electron is gitignored, so this runs as part of every electron build rather than
 * being a committed file.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'dist-electron');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
