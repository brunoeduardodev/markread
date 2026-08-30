#!/usr/bin/env node
import { dirname, relative, resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import getPort from 'get-port';
import open from 'open';
import { randomUUID } from 'node:crypto';
import { startServer } from './server.js';
import { isMarkdown } from './scan.js';
import { clearServerInstance, getServerInstance, saveServerInstance, type ServerInstance } from './instance.js';

const PREFERRED_PORT = 4400;

function parseArgs(argv: string[]) {
  const args = { path: '.', port: undefined as number | undefined, open: true, help: false, version: false, reload: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === 'reload') args.reload = true;
    else if (arg === '--no-open') args.open = false;
    else if (arg === '--port' || arg === '-p') args.port = Number(argv[++i]);
    else if (!arg.startsWith('-')) args.path = arg;
  }
  return args;
}

const HELP = `markread — a reading experience for your Markdown

Usage:
  markread [path]        read Markdown in a folder or open a Markdown file
                         directly (default: .)
  markread reload        restart the active server after an upgrade or build

Options:
  -p, --port <n>         preferred port (default: ${PREFERRED_PORT})
      --no-open          don't open the browser
  -h, --help             show this help
  -v, --version          show version
`;

function readerUrl(port: number, initialDoc?: string): string {
  return `http://localhost:${port}${initialDoc ? `/#/${encodeURIComponent(initialDoc)}` : ''}`;
}

/** Ask the live server to begin serving another folder. A token from the
    owner-only handoff record keeps this localhost control route private. */
async function handOffToServer(instance: ServerInstance, root: string, initialDoc?: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-markread-instance': instance.token },
      body: JSON.stringify({ root, initialDoc }),
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function requestReload(instance: ServerInstance): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${instance.port}/api/reload`, {
      method: 'POST',
      headers: { 'x-markread-instance': instance.token },
      signal: AbortSignal.timeout(1000),
    });
    const body = await response.json().catch(() => null);
    return response.ok && body && typeof body.root === 'string' ? body.root : null;
  } catch {
    return null;
  }
}

async function waitForPort(port: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await getPort({ port }) === port) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function runServer(root: string, port: number): Promise<void> {
  const token = randomUUID();
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server?.close();
    await clearServerInstance(token);
    process.exit(0);
  };

  server = await startServer(root, port, token, shutdown);
  await saveServerInstance({ port, token });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('../package.json');
    console.log(pkg.version);
    return;
  }

  if (args.reload) {
    const existing = await getServerInstance();
    if (!existing) {
      console.error('markread: no active server to reload');
      process.exit(1);
    }
    const root = await requestReload(existing);
    if (!root) {
      console.error('markread: unable to reload the active server');
      process.exit(1);
    }
    if (!await waitForPort(existing.port)) {
      console.error('markread: server did not stop in time');
      process.exit(1);
    }
    await clearServerInstance(existing.token);
    await runServer(root, existing.port);
    console.log(`markread: reloaded ${root}`);
    return;
  }

  const target = resolve(args.path);
  if (!existsSync(target)) {
    console.error(`markread: not found: ${target}`);
    process.exit(1);
  }
  const stats = statSync(target);
  if (!stats.isDirectory() && !stats.isFile()) {
    console.error(`markread: not a file or directory: ${target}`);
    process.exit(1);
  }
  if (stats.isFile() && !isMarkdown(target)) {
    console.error(`markread: not a Markdown file: ${target}`);
    process.exit(1);
  }

  // The reader operates on a directory so the sidebar can still show nearby
  // documents. A file target simply starts the app at that file.
  const root = stats.isDirectory() ? target : dirname(target);
  const initialDoc = stats.isFile() ? relative(root, target).split(sep).join('/') : undefined;

  // Every invocation shares one server. If its owner has exited unexpectedly,
  // discard the stale record and start a fresh instance below.
  const existing = await getServerInstance();
  if (existing && await handOffToServer(existing, root, initialDoc)) {
    const url = readerUrl(existing.port, initialDoc);
    console.log();
    console.log(`  \x1b[1mmarkread\x1b[0m reading \x1b[36m${target}\x1b[0m`);
    console.log(`  \x1b[2m→\x1b[0m ${url} \x1b[2m(existing server)\x1b[0m`);
    console.log();
    if (args.open) await open(url);
    return;
  }
  if (existing) await clearServerInstance(existing.token);

  const port = await getPort({ port: args.port ?? PREFERRED_PORT });
  await runServer(root, port);
  const url = readerUrl(port, initialDoc);

  console.log();
  console.log(`  \x1b[1mmarkread\x1b[0m reading \x1b[36m${target}\x1b[0m`);
  console.log(`  \x1b[2m→\x1b[0m ${url}`);
  console.log();

  if (args.open) await open(url);

}

main().catch((err) => {
  console.error('markread:', err);
  process.exit(1);
});
