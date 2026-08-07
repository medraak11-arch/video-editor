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

export default defineConfig({
  base: './',
  plugins: [react(), devMediaPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
