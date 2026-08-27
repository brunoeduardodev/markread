#!/usr/bin/env node
import { dirname, relative, resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import getPort from 'get-port';
import open from 'open';
import { startServer } from './server.js';
import { isMarkdown } from './scan.js';

const PREFERRED_PORT = 4400;

function parseArgs(argv: string[]) {
  const args = { path: '.', port: undefined as number | undefined, open: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
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

Options:
  -p, --port <n>         preferred port (default: ${PREFERRED_PORT})
      --no-open          don't open the browser
  -h, --help             show this help
  -v, --version          show version
`;

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

  const port = await getPort({ port: args.port ?? PREFERRED_PORT });
  const server = await startServer(root, port);
  const url = `http://localhost:${port}${initialDoc ? `/#/${encodeURIComponent(initialDoc)}` : ''}`;

  console.log();
  console.log(`  \x1b[1mmarkread\x1b[0m reading \x1b[36m${target}\x1b[0m`);
  console.log(`  \x1b[2m→\x1b[0m ${url}`);
  console.log();

  if (args.open) await open(url);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('markread:', err);
  process.exit(1);
});
