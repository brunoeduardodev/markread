import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SectionState {
  dwellMs: number;
  read: boolean;
  /** Whether this section already contributed a WPM calibration sample. */
  sampled?: boolean;
}

export interface FileState {
  scrollY: number;
  sections: Record<string, SectionState>;
  completed: boolean;
  lastOpenedAt: number;
  wordCount: number;
  /** Words in sections marked read — drives sidebar percentages. */
  readWords: number;
}

interface RootState {
  files: Record<string, FileState>;
}

export interface AppState {
  version: 1;
  /** Calibrated words-per-minute; starts at the Brysbaert 2019 norm. */
  wpm: number;
  wpmSamples: number[];
  settings: Record<string, unknown>;
  /** Reserved for stats/heatmap (P1): ISO date → totals. */
  daily: Record<string, { wordsRead: number; msRead: number }>;
  roots: Record<string, RootState>;
}

const STATE_FILE = join(homedir(), '.markread', 'state.json');
const WRITE_DEBOUNCE_MS = 500;

let state: AppState | undefined;
let writeTimer: ReturnType<typeof setTimeout> | undefined;

function emptyState(): AppState {
  return { version: 1, wpm: 238, wpmSamples: [], settings: {}, daily: {}, roots: {} };
}

export async function loadState(): Promise<AppState> {
  if (state) return state;
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    state = parsed?.version === 1 ? (parsed as AppState) : emptyState();
  } catch {
    state = emptyState(); // missing or corrupt — start fresh, never crash
  }
  return state;
}

export function getRootFiles(root: string): Record<string, FileState> {
  if (!state) throw new Error('state not loaded');
  return state.roots[root]?.files ?? {};
}

const emptyFile = (): FileState => ({
  scrollY: 0,
  sections: {},
  completed: false,
  lastOpenedAt: 0,
  wordCount: 0,
  readWords: 0,
});

/** Shallow-merge a patch into a file's state; section entries merge by id,
    keeping max dwell and sticky read flags (progress never regresses). */
export function patchFileState(
  root: string,
  path: string,
  patch: Partial<FileState>,
): FileState {
  if (!state) throw new Error('state not loaded');
  const rootState = (state.roots[root] ??= { files: {} });
  const file = (rootState.files[path] ??= emptyFile());

  if (patch.scrollY !== undefined) file.scrollY = patch.scrollY;
  if (patch.completed !== undefined) file.completed = file.completed || patch.completed;
  if (patch.lastOpenedAt !== undefined) file.lastOpenedAt = patch.lastOpenedAt;
  if (patch.wordCount !== undefined) file.wordCount = patch.wordCount;
  if (patch.readWords !== undefined) file.readWords = Math.max(file.readWords ?? 0, patch.readWords);
  if (patch.sections) {
    for (const [id, incoming] of Object.entries(patch.sections)) {
      const existing = file.sections[id];
      file.sections[id] = existing
        ? {
            dwellMs: Math.max(existing.dwellMs, incoming.dwellMs),
            read: existing.read || incoming.read,
            sampled: existing.sampled || incoming.sampled,
          }
        : incoming;
    }
  }

  schedulePersist();
  return file;
}

/** Forget everything about one file — its progress starts over. */
export function resetFileState(root: string, path: string): void {
  if (!state) throw new Error('state not loaded');
  const rootState = state.roots[root];
  if (rootState?.files[path]) {
    delete rootState.files[path];
    schedulePersist();
  }
}

/** Feed an observed reading-speed sample; wpm becomes the median of the
    last 50 samples, clamped to a sane human range. */
export function addWpmSample(sample: number): number {
  if (!state) throw new Error('state not loaded');
  if (!Number.isFinite(sample) || sample < 60 || sample > 900) return state.wpm;
  state.wpmSamples.push(Math.round(sample));
  if (state.wpmSamples.length > 50) state.wpmSamples.shift();
  // Hold the Brysbaert default until there's enough signal to trust —
  // a single fast section shouldn't retune every estimate in the app.
  if (state.wpmSamples.length >= 5) {
    const sorted = [...state.wpmSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    state.wpm = Math.min(600, Math.max(120, median));
  }
  schedulePersist();
  return state.wpm;
}

/** Shallow-merge a patch into the global settings object (e.g. reading
    typography prefs) and persist. Returns the merged settings. */
export function patchSettings(patch: Record<string, unknown>): Record<string, unknown> {
  if (!state) throw new Error('state not loaded');
  state.settings = { ...state.settings, ...patch };
  schedulePersist();
  return state.settings;
}

function schedulePersist(): void {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => void persist(), WRITE_DEBOUNCE_MS);
}

/** Atomic write: tmp file + rename, so a crash never corrupts state. */
export async function persist(): Promise<void> {
  if (!state) return;
  const tmp = STATE_FILE + '.tmp';
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, STATE_FILE);
  } catch (err) {
    console.warn('[markread] failed to persist state:', err);
  }
}

export async function flushState(): Promise<void> {
  clearTimeout(writeTimer);
  await persist();
}
