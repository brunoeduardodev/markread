import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { WebSocketServer, WebSocket } from 'ws';
import chokidar from 'chokidar';
import { scanDocs, isMarkdown } from './scan.js';
import { initRenderer, renderDoc, countWords } from './render.js';
import { loadState, getRootFiles, patchFileState, resetFileState, flushState, addWpmSample } from './state.js';

/** Brysbaert 2019 meta-analysis: adult silent reading, non-fiction. */
const WPM_DEFAULT = 238;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ico': 'image/x-icon',
};

export interface MarkreadServer {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(root: string, port: number): Promise<MarkreadServer> {
  await initRenderer();
  const appState = await loadState();

  const app = new Hono();
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web');

  app.get('/api/tree', async (c) => {
    const docs = await scanDocs(root);
    // Word counts power the sidebar's folder rollup ("~42 min left").
    const withCounts = await Promise.all(
      docs.map(async (d) => {
        try {
          const wordCount = countWords(await readFile(resolve(root, d.path), 'utf8'));
          return { ...d, wordCount };
        } catch {
          return { ...d, wordCount: 0 };
        }
      }),
    );
    return c.json({ root, docs: withCounts, wpm: appState.wpm });
  });

  // Reading state: everything the progress system knows about this root.
  app.get('/api/state', (c) => {
    return c.json({ wpm: appState.wpm, settings: appState.settings, files: getRootFiles(root) });
  });

  // Progress updates from the reader (debounced client-side; also sendBeacon
  // on pagehide, which arrives as a POST with no content-type).
  app.post('/api/state/file', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.path !== 'string') return c.json({ error: 'bad request' }, 400);
    const file = patchFileState(root, body.path, {
      scrollY: typeof body.scrollY === 'number' ? body.scrollY : undefined,
      sections: body.sections,
      completed: body.completed,
      wordCount: body.wordCount,
      readWords: typeof body.readWords === 'number' ? body.readWords : undefined,
      lastOpenedAt: Date.now(),
    });
    let wpm: number | undefined;
    if (Array.isArray(body.wpmSamples)) {
      for (const sample of body.wpmSamples) wpm = addWpmSample(Number(sample));
    }
    return c.json({ ...file, wpm });
  });

  app.delete('/api/state/file', (c) => {
    const relPath = c.req.query('path');
    if (!relPath) return c.json({ error: 'missing path' }, 400);
    resetFileState(root, relPath);
    return c.json({ ok: true });
  });

  app.get('/api/doc', async (c) => {
    const relPath = c.req.query('path');
    if (!relPath) return c.json({ error: 'missing path' }, 400);

    const abs = resolve(root, relPath);
    // Path-traversal guard: the resolved path must stay inside root.
    if (abs !== root && !abs.startsWith(root + sep)) {
      return c.json({ error: 'path outside root' }, 400);
    }
    if (!isMarkdown(abs) || !existsSync(abs)) {
      return c.json({ error: 'not found' }, 404);
    }

    const source = await readFile(abs, 'utf8');
    const doc = renderDoc(source, relPath.split('/').pop() ?? relPath);
    const minutes = Math.max(1, Math.round(doc.wordCount / WPM_DEFAULT));
    return c.json({ path: relPath, ...doc, minutes });
  });

  // Static SPA assets, falling back to index.html for client-side routing.
  app.get('*', async (c) => {
    const urlPath = new URL(c.req.url).pathname;
    const safe = join(webRoot, urlPath.split('/').filter((s) => s && s !== '..').join(sep));
    const file = existsSync(safe) && extname(safe) ? safe : join(webRoot, 'index.html');
    try {
      const body = await readFile(file);
      // Vite assets are content-hashed (immutable); index.html must revalidate
      // or the browser serves a stale bundle after an upgrade.
      const cache = file.includes('assets') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return c.body(body, 200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        'cache-control': cache,
      });
    } catch {
      return c.text('markread: web assets missing — run `npm run build`', 500);
    }
  });

  const server = serve({ fetch: app.fetch, port }) as HttpServer;

  // Live reload: watch markdown files, push change events over WebSocket.
  const wss = new WebSocketServer({ server, path: '/ws' });
  const broadcast = (msg: object) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  const watcher = chokidar.watch(root, {
    ignored: (path, stats) =>
      path.split(sep).some((part) => part.startsWith('.') || part === 'node_modules' || part === 'dist') ||
      Boolean(stats?.isFile() && !isMarkdown(path)),
    ignoreInitial: true,
  });

  const relOf = (path: string) => resolve(path).slice(root.length + 1).split(sep).join('/');
  watcher.on('change', (path) => broadcast({ type: 'change', path: relOf(path) }));
  watcher.on('add', () => broadcast({ type: 'tree' }));
  watcher.on('unlink', () => broadcast({ type: 'tree' }));

  return {
    port,
    close: async () => {
      await flushState();
      await watcher.close();
      wss.close();
      server.close();
    },
  };
}
