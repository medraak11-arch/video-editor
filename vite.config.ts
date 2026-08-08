import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import type { Connect, ViteDevServer } from 'vite';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const devMediaDir = path.join(rootDir, 'dev-media');

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/**
 * Serves ./dev-media over /dev-media/* in `npm run dev:web`, with Range support so the
 * fixture <video> can actually seek. The folder is gitignored dev-only material; it is
 * deliberately NOT in `public/` so it never lands in a production bundle.
 */
function devMediaPlugin() {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith('/dev-media/')) return next();

    const relative = decodeURIComponent(url.split('?')[0]).slice('/dev-media/'.length);
    const abs = path.join(devMediaDir, relative);
    if (!abs.startsWith(devMediaDir) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    const stat = fs.statSync(abs);
    const type = MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    const range = req.headers.range;

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : stat.size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Type', type);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(stat.size));
    fs.createReadStream(abs).pipe(res);
  };

  return {
    name: 've-dev-media',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(middleware);
    },
  };
}

/* --------------------------------------------------------- the splash CSP
   RELEASE.md §3.6. The splash needs strictly less than index.html, but the
   policy is environment-dependent: @vitejs/plugin-react injects an INLINE
   react-refresh preamble into every HTML entry and Vite's client opens an HMR
   WebSocket, so the production policy would fill the dev console with
   violations and stop the splash from hot-reloading. The production policy is
   the one that ships and the one the gates read out of dist/splash.html.     */

const PROD_CSP =
  "default-src 'self'; connect-src 'none'; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:;";
const DEV_CSP =
  "default-src 'self'; connect-src 'self' ws://localhost:5173 http://localhost:5173; " +
  "img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; font-src 'self' data:;";

function veSplashCsp(command: 'build' | 'serve') {
  return {
    name: 've-splash-csp',
    transformIndexHtml(html: string, ctx: { path: string }) {
      if (!ctx.path.endsWith('splash.html')) return html;
      return html.replace('%VE_SPLASH_CSP%', command === 'build' ? PROD_CSP : DEV_CSP);
    },
  };
}

/* The version is READ, not imported: `import … assert { type: 'json' }` is gone
   in Node 23+ and its replacement's support depends on which tsconfig picks the
   file up. RELEASE.md §2.2. */
const pkg = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [react(), devMediaPlugin(), veSplashCsp(command)],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  // Consumed only by src/dev/fixtures.ts, which never reaches the Electron
  // bundle. Main reads app.getVersion() instead — RELEASE.md §2.1.
  define: { __VE_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        splash: fileURLToPath(new URL('./splash.html', import.meta.url)),
      },
    },
  },
}));
