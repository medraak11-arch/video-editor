/* ---------------------------------------------------------------------------
   main.tsx — the renderer entry point. Scaffold-owned. PLAN §1.1.

   Two jobs, in this order:

     1. If `window.editorAPI` is absent — which is exactly `npm run dev:web` —
        pull in the fixture bridge through a DYNAMIC import and register it
        before anything can call getEditorAPI(). The import is dynamic so the
        41-clip fixture project is a separate chunk the Electron build never
        fetches, and so `src/lib/**` keeps its "never imports src/dev/**" rule.
     2. Mount <App />.

   The stylesheets are imported here, ahead of App, so tokens.css and base.css
   land before any component stylesheet in the emitted bundle: a component rule
   must never win over a token declaration by source order.
--------------------------------------------------------------------------- */

import './styles/tokens.css';
import './styles/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { isElectron, registerFallbackAPI } from './lib/editorApi';

async function boot(): Promise<void> {
  if (!isElectron()) {
    const dev = await import('./dev/fixtures');
    registerFallbackAPI(dev.fixtureAPI);
    // Before the first render: the store is already populated when App mounts, so
    // nothing paints an empty editor and then fills in (PRODUCT.md — the app opens
    // into the task, it does not animate itself into existence).
    dev.bootstrapFixtures();
  }

  const host = document.getElementById('root');
  if (!host) throw new Error('main.tsx: #root is missing from index.html');

  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
