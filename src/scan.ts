import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'vendor', 'target']);
const MD_EXTENSIONS = /\.(md|markdown)$/i;

export interface DocEntry {
  /** Path relative to the scanned root, using `/` separators. */
  path: string;
  name: string;
  dir: string;
}

export function isMarkdown(path: string): boolean {
  return MD_EXTENSIONS.test(path);
}

/** Recursively find markdown files under root, skipping hidden and dependency dirs. */
export async function scanDocs(root: string): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];

  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        if (!IGNORED_DIRS.has(item.name)) await walk(full);
      } else if (item.isFile() && isMarkdown(item.name)) {
        const rel = relative(root, full).split('\\').join('/');
        const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        entries.push({ path: rel, name: item.name, dir: dirRel });
      }
    }
  }

  await walk(root);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries;
}
