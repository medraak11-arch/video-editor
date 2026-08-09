/* ---------------------------------------------------------------------------
   splash.ts — the start-up splash's entry. docs/RELEASE.md §3.

   Plain TypeScript against `document`. NO REACT: this is a handful of DOM nodes
   and one subscription, and pulling React, ReactDOM and the store into a window
   whose entire job is to appear quickly would be the opposite of the point.

   The import list is exact and each line is load-bearing (§3.6): tokens alone
   would render with no Inter and no JetBrains Mono and with none of the six
   type utilities, and base.css cannot be imported because it paints `body`
   opaque and destroys the transparent rounded card.
--------------------------------------------------------------------------- */

import '../styles/tokens.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../styles/type.css';
import './splash.css';

import type { SplashStatus } from '../types/api';
import { appMarkSvg, benchSvg } from './graphic';

/** §3.7's ceiling on the font race. Not a delay: a cached font resolves in
 *  single-digit milliseconds and a cold first launch is capped rather than
 *  blocked. A webfont swapping in at 400ms would resize the 44px wordmark while
 *  the user is looking at it, which is visible motion at rest. */
const FONT_SETTLE_CEILING_MS = 120;

const root = document.getElementById('splash');

/* ------------------------------------------------------------- the proof view
   §3.14 gate 1. Dev only, and it never reaches a packaged build's launch path:
   electron/splash.ts loads splash.html with no query string. */

function renderProof(host: HTMLElement): void {
  host.className = 've-splash-proof';
  host.innerHTML =
    `<div class="ve-splash-proof-1x">${benchSvg()}</div>` +
    `<div class="ve-splash-proof-2x">${benchSvg()}</div>`;
}

/* ------------------------------------------------------------------ the card */

function renderCard(host: HTMLElement): void {
  const build = window.splashAPI?.build ?? null;
  host.className = 've-splash';
  host.innerHTML = [
    '<div class="ve-splash-left">',
    appMarkSvg(28),
    '<h1 class="ve-splash-wordmark">',
    '<span class="ve-splash-wordmark-light">Medrak Cut</span>',
    '<span class="ve-splash-wordmark-bold">Video Editor</span>',
    '</h1>',
    '<div class="ve-splash-tagline">',
    '<p class="ve-splash-tagline-lead type-body">Open it and start cutting.</p>',
    '<p class="ve-splash-tagline-rest type-body">Full timeline editing. No accounts, no cloud.</p>',
    '</div>',
    '<div class="ve-splash-spacer"></div>',
    '<div class="ve-splash-status" id="splash-status"></div>',
    '<div class="ve-splash-footer">',
    '<p class="type-label">© 2026</p>',
    '<p class="ve-splash-version">',
    '<span class="type-label">Version</span>',
    `<span class="type-numeric">${build ? escapeText(build.version) : 'unknown'}</span>`,
    '</p>',
    '</div>',
    '</div>',
    `<div class="ve-splash-right">${benchSvg()}</div>`,
  ].join('');
}

/** The only value on this page that does not come from a literal in this file.
 *  A version is `[0-9a-zA-Z.+-]` in practice, but it arrives over argv and is
 *  written into markup, so it is escaped rather than trusted. */
function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}

/* ------------------------------------------------------------- the status line
   Never drawn alone: a fill with no label is a bar with no meaning, and a label
   with no fill loses the one piece of structure that says how much is left. So
   `label === null` empties the whole block, rule included (§3.9).            */

function renderStatus(hostId: string, s: SplashStatus): void {
  const host = document.getElementById(hostId);
  if (!host) return;
  if (s.label === null) {
    host.innerHTML = '';
    return;
  }
  const done = Math.max(0, Math.min(s.done, s.total));
  const percent = s.total > 0 ? (done / s.total) * 100 : 0;
  host.innerHTML = [
    '<div class="ve-splash-status-line">',
    '<span class="ve-splash-dot"></span>',
    `<span class="ve-splash-status-label type-label">${escapeText(s.label)}</span>`,
    '</div>',
    '<div class="ve-splash-rule">',
    `<div class="ve-splash-rule-fill" style="width: ${percent}%"></div>`,
    '</div>',
  ].join('');
}

/* ------------------------------------------------------------------- start-up */

async function start(host: HTMLElement): Promise<void> {
  renderCard(host);
  window.splashAPI?.onStatus((s) => renderStatus('splash-status', s));

  // Tell main only once the fonts have settled. This is condition 2 of §3.4's
  // show rule — the splash window's own ready-to-show is only that condition's
  // timed fallback, for a renderer that never gets this far.
  await Promise.race([
    document.fonts.ready,
    new Promise((resolve) => setTimeout(resolve, FONT_SETTLE_CEILING_MS)),
  ]);
  window.splashAPI?.ready();
}

if (root) {
  if (new URLSearchParams(window.location.search).has('proof')) renderProof(root);
  else void start(root);
}
