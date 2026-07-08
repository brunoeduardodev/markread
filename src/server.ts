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
import { initRenderer, renderDoc } from './render.js';

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

  const app = new Hono();
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'web');

  app.get('/api/tree', async (c) => {
    const docs = await scanDocs(root);
    return c.json({ root, docs });
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
      return c.body(body, 200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
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
      await watcher.close();
      wss.close();
      server.close();
    },
  };
}
