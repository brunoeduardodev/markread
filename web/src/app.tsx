import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { ProgressTracker, type SectionMeta, type SectionProgress } from './progress.js';
import { enhanceDoc } from './enhance.js';

interface DocEntry {
  path: string;
  name: string;
  dir: string;
  wordCount: number;
}

interface Heading {
  level: number;
  text: string;
  id: string;
  wordCount: number;
}

interface Doc {
  path: string;
  html: string;
  headings: Heading[];
  wordCount: number;
  minutes: number;
  title: string;
}

interface FileState {
  scrollY: number;
  sections: Record<string, SectionProgress>;
  completed: boolean;
  readWords: number;
}

interface FavoriteWorkspace {
  path: string;
  name: string;
  addedAt: number;
  lastOpenedAt: number;
}

const THEMES = ['light', 'vesper', 'tokyo-night'] as const;
type Theme = (typeof THEMES)[number];

function initialTheme(): Theme {
  const stored = localStorage.getItem('markread:theme') as Theme | null;
  if (stored && THEMES.includes(stored)) return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'vesper' : 'light';
}

const RULERS = ['off', 'bar', 'shade', 'underline'] as const;
type Ruler = (typeof RULERS)[number];

function initialRuler(): Ruler {
  const stored = localStorage.getItem('markread:ruler') as Ruler | null;
  return stored && RULERS.includes(stored) ? stored : 'off';
}

/* --- Personalization panel: reading typography settings -------------------
   Server-side (survives port changes), never localStorage. Hydrated from
   /api/state, patched via POST /api/state/settings (debounced). */

const FONT_CHOICES = ['literata', 'atkinson', 'system-serif', 'system-sans'] as const;
type FontChoice = (typeof FONT_CHOICES)[number];

const SPACING_CHOICES = ['normal', 'relaxed'] as const;
type Spacing = (typeof SPACING_CHOICES)[number];

interface Settings {
  font: FontChoice;
  size: number; // px, 16–24
  leading: number; // 1.4–1.9
  measure: number; // ch, 55–80
  spacing: Spacing;
}

const DEFAULT_SETTINGS: Settings = { font: 'literata', size: 20, leading: 1.6, measure: 68, spacing: 'normal' };

const PRESETS: Record<string, Settings> = {
  default: DEFAULT_SETTINGS,
  cozy: { font: 'literata', size: 21, leading: 1.7, measure: 62, spacing: 'normal' },
  airy: { font: 'atkinson', size: 20, leading: 1.75, measure: 64, spacing: 'relaxed' },
  compact: { font: 'system-sans', size: 18, leading: 1.5, measure: 72, spacing: 'normal' },
};

const FONT_STACKS: Record<FontChoice, string> = {
  literata: "'Literata Variable', Georgia, serif",
  atkinson: "'Atkinson Hyperlegible', 'Literata Variable', serif",
  'system-serif': "Georgia, 'Iowan Old Style', serif",
  'system-sans': "-apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif",
};

const FONT_LABELS: Record<FontChoice, string> = {
  literata: 'Literata',
  atkinson: 'Atkinson',
  'system-serif': 'Serif',
  'system-sans': 'Sans',
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Validate an arbitrary payload (server settings, possibly stale/partial)
    into a fully-formed Settings object, falling back to defaults per field. */
function sanitizeSettings(raw: unknown): Settings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const font = FONT_CHOICES.includes(r.font as FontChoice) ? (r.font as FontChoice) : DEFAULT_SETTINGS.font;
  const size = typeof r.size === 'number' ? clamp(Math.round(r.size), 16, 24) : DEFAULT_SETTINGS.size;
  const leading = typeof r.leading === 'number' ? round2(clamp(r.leading, 1.4, 1.9)) : DEFAULT_SETTINGS.leading;
  const measure = typeof r.measure === 'number' ? clamp(Math.round(r.measure), 55, 80) : DEFAULT_SETTINGS.measure;
  const spacing = SPACING_CHOICES.includes(r.spacing as Spacing) ? (r.spacing as Spacing) : DEFAULT_SETTINGS.spacing;
  return { font, size, leading, measure, spacing };
}

function currentHashPath(): string {
  return decodeURIComponent(location.hash.replace(/^#\//, ''));
}

// We own scroll restoration: resume comes from reading state, not the browser.
history.scrollRestoration = 'manual';

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function readerJumpTo(y: number) {
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo({
    top: Math.max(0, Math.min(maxScroll, y)),
    behavior: 'instant',
  });
}

function readerJumpToElement(element: HTMLElement | null) {
  if (!element) return;
  element.scrollIntoView({ block: 'start', behavior: 'instant' });
}

/**
 * Let the browser animate pointer-triggered reading jumps. Native scrolling
 * stays smooth at any refresh rate and is interruptible by wheel or touch.
 */
function readerScrollToElement(element: HTMLElement | null) {
  if (!element) return;
  element.scrollIntoView({
    block: 'start',
    behavior: reducedMotion() ? 'instant' : 'smooth',
  });
}

// The mouse always wins: any real scroll input cancels the keyboard glide,
// otherwise a programmatic jump can keep moving after the reader takes over.
for (const cancelEvent of ['wheel', 'touchstart'] as const) {
  addEventListener(cancelEvent, () => stopSlide(), { passive: true });
}
// A slide must never outlive its keypress (e.g. tab switch mid-hold).
addEventListener('blur', () => stopSlide());

/**
 * j/k slide: hold to scroll at a constant, followable velocity — text flows
 * through the reading ruler instead of hopping past it. Release to stop.
 * A quick tap completes exactly one computed body line.
 */
const SLIDE_PX_PER_S = 170;
const slide = { dir: 0 as -1 | 0 | 1, raf: 0, lastT: 0, distance: 0 };

function readerLineHeight() {
  const lineHeight = Number.parseFloat(getComputedStyle(document.body).lineHeight);
  return Number.isFinite(lineHeight) ? lineHeight : 0;
}

function startSlide(dir: -1 | 1) {
  if (slide.dir === dir) return; // key repeat
  const wasIdle = slide.dir === 0;
  slide.dir = dir;
  if (!wasIdle) return; // direction change mid-slide: just steer
  window.scrollTo({ top: window.scrollY, behavior: 'instant' }); // a slide supersedes any pending jump
  slide.lastT = performance.now();
  slide.distance = 0;
  const step = (t: number) => {
    if (slide.dir === 0) return;
    const dt = Math.min(64, t - slide.lastT) / 1000; // clamp tab-jank spikes
    slide.lastT = t;
    const delta = slide.dir * SLIDE_PX_PER_S * dt;
    slide.distance += Math.abs(delta);
    window.scrollBy({ top: delta, behavior: 'instant' });
    slide.raf = requestAnimationFrame(step);
  };
  slide.raf = requestAnimationFrame(step);
}

function stopSlide(completeTap = false) {
  const dir = slide.dir;
  const remaining = completeTap && dir !== 0
    ? Math.max(0, readerLineHeight() - slide.distance)
    : 0;
  slide.dir = 0;
  slide.distance = 0;
  cancelAnimationFrame(slide.raf);
  if (remaining > 0) {
    window.scrollBy({ top: dir * remaining, behavior: 'instant' });
  }
}

/** Focus level 2: mark the direct child of .doc-content nearest the reading
    line (30% down the viewport) as `.current` so CSS can dim the rest. */
function updateCurrentBlock() {
  const article = document.querySelector('.doc-content');
  if (!article) return;
  const line = window.scrollY + window.innerHeight * 0.3;
  const children = Array.from(article.children) as HTMLElement[];
  if (children.length === 0) return;

  let current: HTMLElement | null = null;
  for (const child of children) {
    const rect = child.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const bottom = top + rect.height;
    if (line >= top && line < bottom) {
      current = child;
      break;
    }
  }
  if (!current) {
    const firstTop = children[0].getBoundingClientRect().top + window.scrollY;
    current = line < firstTop ? children[0] : children[children.length - 1];
  }
  for (const child of children) child.classList.toggle('current', child === current);
}

/** Sections that participate in progress: bounded at heading level ≤ 3. */
const progressSections = (doc: Doc): SectionMeta[] =>
  doc.headings.filter((h) => h.level <= 3);

/** Next not-yet-completed doc after `from`, wrapping around the folder. */
function nextUnread(
  docs: DocEntry[],
  state: Record<string, FileState>,
  from: number,
): DocEntry | undefined {
  for (let i = 1; i <= docs.length; i++) {
    const candidate = docs[(from + i) % docs.length];
    if (!state[candidate.path]?.completed) return candidate;
  }
  return undefined;
}

const PERSIST_INTERVAL_MS = 3000;

export function App() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [active, setActive] = useState<string>(currentHashPath());
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [resumeTop, setResumeTop] = useState<number | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Dopamine layer: transient cues, all deterministic, all truthful.
  const [metaFlash, setMetaFlash] = useState<string | null>(null);
  const [rollupFlash, setRollupFlash] = useState(false);
  const [folderClear, setFolderClear] = useState<string | null>(null);
  // State, not an imperative class — re-renders would clobber the latter.
  const [nextUpId, setNextUpId] = useState<string | null>(null);
  const [ringPulse, setRingPulse] = useState(false);
  // Bumped whenever dwell progress changes; cheap way to re-render TOC/bar.
  const [, setProgressVersion] = useState(0);
  // Focus mode: 0 off, 1 focus (chrome hidden), 2 focus+dim. Ephemeral.
  const [focusLevel, setFocusLevel] = useState(0);
  const [ruler, setRuler] = useState<Ruler>(initialRuler);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [favorites, setFavorites] = useState<FavoriteWorkspace[]>([]);
  const [currentRoot, setCurrentRoot] = useState('');
  const [favoriteError, setFavoriteError] = useState<string | null>(null);

  const tracker = useRef(new ProgressTracker());
  // Dev affordance: inspectable from the browser console.
  (window as unknown as { __markread: ProgressTracker }).__markread = tracker.current;
  const filesState = useRef<Record<string, FileState>>({});
  const focusLevelRef = useRef(0);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const wpm = useRef(238);
  const docRef = useRef<Doc | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  // Resolves once /api/state has been loaded — loadDoc must wait for it,
  // otherwise resume races the state fetch and silently restores to 0.
  const stateReady = useRef<Promise<void> | null>(null);
  // Observed reading-speed samples awaiting the next persist.
  const wpmQueue = useRef<number[]>([]);
  // Dopamine layer bookkeeping
  const sessionCompletions = useRef(0);
  const lastCueAt = useRef(0);
  const prevDoneCount = useRef(-1);
  const folderClearShown = useRef(false);
  // Milestone celebrations: long docs (>20 min) every 10%, short docs at
  // quarters. 100% belongs to the completion pill, not this system.
  const milestoneMarks = useRef<number[]>([]);
  const milestonesShown = useRef<Set<number>>(new Set());
  const metaFlashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Sections auto-passed while a doc is being (re)initialized aren't earned —
  // no cues for them, and no budget drain either.
  const suppressCues = useRef(false);

  /** Celebration budget for sub-completion cues: at most one per window.
      Completion-level moments (doc/folder) are exempt — they're the stars. */
  const tryCue = useCallback(() => {
    const now = performance.now();
    if (now - lastCueAt.current < 8000) return false;
    lastCueAt.current = now;
    return true;
  }, []);

  const flashMeta = useCallback((text: string) => {
    setMetaFlash(text);
    clearTimeout(metaFlashTimer.current);
    metaFlashTimer.current = setTimeout(() => setMetaFlash(null), 1600);
  }, []);
  // Settings hydration: guards the debounced-persist effect from firing on
  // default state before /api/state resolves, and from re-POSTing the exact
  // payload it just hydrated.
  const settingsHydrated = useRef(false);
  const lastPersistedSettings = useRef(JSON.stringify(DEFAULT_SETTINGS));

  const persistProgress = useCallback((path: string, useBeacon = false) => {
    const t = tracker.current;
    if (!path || !docRef.current) return;
    const completed = t.allRead() || filesState.current[path]?.completed || false;
    const payload = JSON.stringify({
      path,
      scrollY: Math.round(window.scrollY),
      sections: t.snapshot(),
      wordCount: docRef.current.wordCount,
      readWords: t.readWords(),
      completed,
      wpmSamples: wpmQueue.current.splice(0),
    });
    t.dirty = false;
    if (useBeacon) {
      navigator.sendBeacon('/api/state/file', new Blob([payload], { type: 'application/json' }));
    } else {
      fetch('/api/state/file', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      })
        .then((r) => r.json())
        .then((res) => {
          if (typeof res?.wpm === 'number') wpm.current = res.wpm;
        })
        .catch(() => {});
    }
    // Keep the local mirror fresh so doc switches resume correctly.
    filesState.current[path] = {
      scrollY: Math.round(window.scrollY),
      sections: t.snapshot(),
      completed,
      readWords: t.readWords(),
    };
  }, []);

  const loadTree = useCallback(async () => {
    const res = await fetch('/api/tree');
    const data = await res.json();
    setDocs(data.docs);
    setCurrentRoot(typeof data.root === 'string' ? data.root : '');
  }, []);

  const loadFavorites = useCallback(async () => {
    const res = await fetch('/api/favorites');
    if (!res.ok) return;
    const data = await res.json();
    setFavorites(Array.isArray(data.favorites) ? data.favorites : []);
  }, []);

  const hydrateState = useCallback(async () => {
    const stateRes = await fetch('/api/state').then((r) => r.json());
    filesState.current = stateRes.files ?? {};
    wpm.current = stateRes.wpm ?? 238;
    const hydrated = sanitizeSettings(stateRes.settings);
    lastPersistedSettings.current = JSON.stringify(hydrated);
    settingsHydrated.current = true;
    setSettings(hydrated);
  }, []);

  const toggleFavorite = useCallback(async () => {
    if (!currentRoot) return;
    setFavoriteError(null);
    const saved = favorites.some((favorite) => favorite.path === currentRoot);
    const response = await fetch(saved ? `/api/favorites?path=${encodeURIComponent(currentRoot)}` : '/api/favorites', {
      method: saved ? 'DELETE' : 'POST',
    }).catch(() => null);
    if (!response?.ok) {
      setFavoriteError(saved ? 'could not remove saved folder' : 'could not save folder');
      return;
    }
    await loadFavorites();
  }, [currentRoot, favorites, loadFavorites]);

  const openFavorite = useCallback(async (path: string) => {
    if (path === currentRoot) return;
    setFavoriteError(null);
    const response = await fetch('/api/favorites/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch(() => null);
    if (!response?.ok) {
      const data = response ? await response.json().catch(() => null) : null;
      setFavoriteError(data?.error === 'folder not found' ? 'folder is no longer available' : 'could not open folder');
      return;
    }
    await loadFavorites();
  }, [currentRoot, loadFavorites]);

  const forgetFavorite = useCallback(async (path: string) => {
    setFavoriteError(null);
    const response = await fetch(`/api/favorites?path=${encodeURIComponent(path)}`, { method: 'DELETE' }).catch(() => null);
    if (!response?.ok) {
      setFavoriteError('could not remove saved folder');
      return;
    }
    await loadFavorites();
  }, [loadFavorites]);

  const loadDoc = useCallback(async (path: string, preserveScroll = false) => {
    if (!path) return;
    const scrollBefore = window.scrollY;
    await stateReady.current;
    const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data: Doc = await res.json();
    setDoc(data);
    docRef.current = data;
    setResumeTop(null);
    setJustCompleted(false);
    setConfirmReset(false);

    requestAnimationFrame(() => {
      const saved = filesState.current[path];
      const target = preserveScroll ? scrollBefore : (saved?.scrollY ?? 0);
      window.scrollTo({ top: target, behavior: 'instant' });

      const t = tracker.current;
      t.wpm = wpm.current;
      suppressCues.current = true;
      t.setDoc(progressSections(data), saved?.sections ?? {});
      suppressCues.current = false;
      t.start();
      // Milestones already behind the resume point don't re-celebrate.
      const pctAtLoad = (t.passedWords() / Math.max(1, data.wordCount)) * 100;
      milestoneMarks.current = data.minutes > 20 ? [10, 20, 30, 40, 50, 60, 70, 80, 90] : [25, 50, 75];
      milestonesShown.current = new Set(milestoneMarks.current.filter((m) => pctAtLoad >= m));
      setActiveSection(t.currentSectionId());
      setProgressVersion((v) => v + 1);

      // Re-entry cue: a fading "you were here" line at the resume point.
      if (!preserveScroll && target > 400) {
        setResumeTop(target + 32);
        setTimeout(() => setResumeTop(null), 4000);
      }
    });
  }, []);

  // Start over on the open document: forget server state, jump to the top,
  // and re-seed the tracker as if the doc had never been opened.
  const resetProgress = useCallback(async () => {
    const current = docRef.current;
    if (!current) return;
    await fetch(`/api/state/file?path=${encodeURIComponent(current.path)}`, {
      method: 'DELETE',
    }).catch(() => {});
    delete filesState.current[current.path];
    window.scrollTo({ top: 0, behavior: 'instant' });
    suppressCues.current = true;
    tracker.current.setDoc(progressSections(current), {});
    suppressCues.current = false;
    const pctAtReset = (tracker.current.passedWords() / Math.max(1, current.wordCount)) * 100;
    milestonesShown.current = new Set(milestoneMarks.current.filter((m) => pctAtReset >= m));
    setJustCompleted(false);
    setConfirmReset(false);
    setActiveSection(tracker.current.currentSectionId());
    setProgressVersion((v) => v + 1);
  }, []);

  // The confirm state reverts on its own if the second click never comes.
  useEffect(() => {
    if (!confirmReset) return;
    const timer = setTimeout(() => setConfirmReset(false), 2500);
    return () => clearTimeout(timer);
  }, [confirmReset]);

  // Theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('markread:theme', theme);
  }, [theme]);

  // Post-render enhancement: mermaid diagrams + KaTeX CSS (lazy chunks).
  // Re-runs on theme change so diagrams re-render in the matching palette.
  useEffect(() => {
    if (doc && contentRef.current) enhanceDoc(contentRef.current, theme);
  }, [doc, theme]);

  // Reading ruler choice persists; focus level does not.
  useEffect(() => {
    localStorage.setItem('markread:ruler', ruler);
  }, [ruler]);

  // Apply personalization settings as CSS custom properties — live preview,
  // no re-render of the document itself required.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--font-body', FONT_STACKS[settings.font]);
    root.setProperty('--body-size', `${settings.size / 16}rem`);
    root.setProperty('--body-leading', String(settings.leading));
    root.setProperty('--measure', `${settings.measure}ch`);
    if (settings.spacing === 'relaxed') {
      root.setProperty('--body-letter-spacing', '0.035em');
      root.setProperty('--body-word-spacing', '0.06em');
    } else {
      root.setProperty('--body-letter-spacing', 'normal');
      root.setProperty('--body-word-spacing', 'normal');
    }
  }, [settings]);

  // Debounced persistence to the server (settings live in ~/.markread/state.json,
  // not localStorage, so they survive port changes). Skipped until hydrated
  // and skipped when unchanged from the last persisted/hydrated value.
  useEffect(() => {
    if (!settingsHydrated.current) return;
    const serialized = JSON.stringify(settings);
    if (serialized === lastPersistedSettings.current) return;
    const timer = setTimeout(() => {
      lastPersistedSettings.current = serialized;
      fetch('/api/state/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serialized,
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [settings]);

  // Mirror focus level into a ref for the scroll-spy effect (stable deps),
  // and re-measure the current block the moment level 2 turns on.
  useEffect(() => {
    focusLevelRef.current = focusLevel;
    if (focusLevel === 2) updateCurrentBlock();
  }, [focusLevel]);

  // Initial load: tree + reading state. loadDoc awaits stateReady, so the
  // first document render always sees persisted progress.
  useEffect(() => {
    stateReady.current = hydrateState().catch(() => {});
    loadTree();
    loadFavorites();

    const onHash = () => setActive(currentHashPath());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [hydrateState, loadTree, loadFavorites]);

  // Default to first doc (prefer README) when nothing selected
  useEffect(() => {
    if (!active && docs.length > 0) {
      const readme = docs.find((d) => /^readme\.md$/i.test(d.name));
      location.hash = `#/${(readme ?? docs[0]).path}`;
    }
  }, [docs, active]);

  useEffect(() => {
    // Flush the doc we're leaving before loading the next one.
    return () => {
      if (docRef.current) persistProgress(docRef.current.path);
    };
  }, [active, persistProgress]);

  useEffect(() => {
    loadDoc(active);
  }, [active, loadDoc]);

  // Progress persistence: periodic while dirty, and on tab close.
  useEffect(() => {
    const interval = setInterval(() => {
      if (tracker.current.dirty && docRef.current) persistProgress(docRef.current.path);
    }, PERSIST_INTERVAL_MS);
    const onPageHide = () => docRef.current && persistProgress(docRef.current.path, true);
    addEventListener('pagehide', onPageHide);
    return () => {
      clearInterval(interval);
      removeEventListener('pagehide', onPageHide);
    };
  }, [persistProgress]);

  // Progress → UI updates, completion detection, WPM samples, dopamine cues
  useEffect(() => {
    const t = tracker.current;
    t.onTick = () => {
      setProgressVersion((v) => v + 1);
      // Milestone celebrations — every unshown mark behind the line is
      // marked, but only the furthest one celebrates (budgeted).
      const d = docRef.current;
      if (!d) return;
      const pct = (t.passedWords() / Math.max(1, d.wordCount)) * 100;
      let crossed: number | undefined;
      for (const mark of milestoneMarks.current) {
        if (pct >= mark && !milestonesShown.current.has(mark)) {
          milestonesShown.current.add(mark);
          crossed = mark;
        }
      }
      // Milestones outrank section deltas: they always celebrate (they're
      // self-limiting — at most 9 per doc) and claim the cue budget so a
      // lesser cue can't fire right on their heels.
      if (crossed !== undefined && !t.allRead() && !suppressCues.current) {
        lastCueAt.current = performance.now();
        flashMeta(`${crossed}% ·`);
        setRingPulse(true);
        setTimeout(() => setRingPulse(false), 650);
      }
    };
    t.onRead = (id) => {
      setProgressVersion((v) => v + 1);
      const d = docRef.current;
      const secs = d ? progressSections(d) : [];
      const section = secs.find((s) => s.id === id);

      // Sub-completion cues share one budget: at most one animated moment
      // per window, or fast readers get a fireworks strip instead of calm.
      // A read that completes the doc gets the pill instead — no competing flash.
      if (!suppressCues.current && !t.allRead() && section && section.wordCount >= 50 && tryCue()) {
        // Delta pulse: progress framed as time earned back.
        flashMeta(`−${Math.max(1, Math.round(section.wordCount / wpm.current))} min`);
        // Next-up shimmer: the reward points forward.
        const next = secs[secs.indexOf(section) + 1];
        if (next) {
          setNextUpId(next.id);
          setTimeout(() => setNextUpId(null), 1500);
        }
      }

      const path = d?.path;
      if (path && t.allRead() && !filesState.current[path]?.completed) {
        sessionCompletions.current += 1;
        setJustCompleted(true);
        persistProgress(path); // make the ✓ durable immediately
      }
    };
    t.onSample = (sample) => wpmQueue.current.push(sample);
    return () => t.stop();
  }, [persistProgress, tryCue, flashMeta]);

  // Scroll-spy + section re-measure on resize
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setActiveSection(tracker.current.currentSectionId());
        if (focusLevelRef.current === 2) updateCurrentBlock();
      });
    };
    const onResize = () => {
      tracker.current.measure();
      onScroll();
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onResize);
    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onResize);
    };
  }, []);

  // Live reload over WebSocket
  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    let reloadAfterReconnect = false;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`);
      ws.onopen = () => {
        // The CLI restarted the server after a build or upgrade. Waiting for
        // this fresh connection means the document reload gets the new bundle.
        if (reloadAfterReconnect) location.reload();
      };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'change' && msg.path === currentHashPath()) {
          loadDoc(msg.path, true); // preserve scroll — agents rewrite files mid-read
        } else if (msg.type === 'tree') {
          loadTree();
        } else if (msg.type === 'root') {
          // A later `markread path` call repoints the shared server. Reload
          // both root-scoped progress and the file tree before navigating.
          // Clear the previous document first: its rendered HTML belongs to
          // the old filesystem root and must never linger in a new workspace.
          const nextPath = typeof msg.path === 'string' ? msg.path : '';
          tracker.current.stop();
          docRef.current = null;
          setDoc(null);
          setActiveSection(null);
          setJustCompleted(false);
          hydrateState()
            .then(loadTree)
            .then(loadFavorites)
            .then(() => {
              location.hash = nextPath ? `#/${nextPath}` : '';
              // Hashchange does not fire when a tab is already at the target
              // hash, so make the routing state explicit as well.
              setActive(nextPath);
            })
            .catch(() => {});
        } else if (msg.type === 'restart') {
          reloadAfterReconnect = true;
        }
      };
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [hydrateState, loadDoc, loadTree]);

  // In-document anchor links (footnotes, etc.) scroll instead of breaking
  // the #/file hash routing.
  const onArticleClick = useCallback((event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('#') && !href.startsWith('#/')) {
      event.preventDefault();
      readerScrollToElement(document.getElementById(decodeURIComponent(href.slice(1))));
    }
  }, []);

  // Keyboard: j/k scroll · n/p file nav · [/] sections · g/G top/bottom ·
  // f focus · r ruler · t theme · / filter · ? help · Esc close/exit
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const path = currentHashPath();
      const index = docs.findIndex((d) => d.path === path);
      if (event.key === 'j') startSlide(1);
      else if (event.key === 'k') startSlide(-1);
      else if (event.key === 'n') {
        // Chain-loading: once the current doc is complete, n jumps to the
        // next unread doc; otherwise it's plain next-file.
        const target = filesState.current[path]?.completed
          ? nextUnread(docs, filesState.current, index)
          : docs[index + 1];
        if (target) location.hash = `#/${target.path}`;
      } else if (event.key === 'p' && index > 0) location.hash = `#/${docs[index - 1].path}`;
      else if (event.key === 't') setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
      else if (event.key === '[' || event.key === ']') {
        const headingSections = docRef.current ? progressSections(docRef.current) : [];
        if (headingSections.length === 0) return;
        const currentId = tracker.current.currentSectionId();
        let idx = headingSections.findIndex((s) => s.id === currentId);
        if (idx === -1) idx = event.key === ']' ? -1 : 0;
        const nextIdx = event.key === ']'
          ? Math.min(headingSections.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        readerJumpToElement(document.getElementById(headingSections[nextIdx].id));
      } else if (event.key === 'g') readerJumpTo(0);
      else if (event.key === 'G') readerJumpTo(document.documentElement.scrollHeight);
      else if (event.key === 'f') setFocusLevel((l) => (l + 1) % 3);
      else if (event.key === 'r') setRuler((r) => RULERS[(RULERS.indexOf(r) + 1) % RULERS.length]);
      // Shift+R: reset progress with the same two-step confirm as the ↺ button.
      else if (event.key === 'R') {
        if (confirmReset) resetProgress();
        else setConfirmReset(true);
      }
      else if (event.key === 's') setSettingsOpen((o) => !o);
      else if (event.key === '/') {
        event.preventDefault();
        filterInputRef.current?.focus();
      } else if (event.key === '?') setHelpOpen((h) => !h);
      else if (event.key === 'Escape') {
        // Priority: close help → close settings panel → clear/blur filter → exit focus mode.
        if (helpOpen) setHelpOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (filterQuery) {
          setFilterQuery('');
          filterInputRef.current?.blur();
        } else if (focusLevel > 0) setFocusLevel(0);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'j' || event.key === 'k') stopSlide(true);
    };
    addEventListener('keydown', onKey);
    addEventListener('keyup', onKeyUp);
    return () => {
      removeEventListener('keydown', onKey);
      removeEventListener('keyup', onKeyUp);
      stopSlide();
    };
  }, [docs, helpOpen, filterQuery, focusLevel, settingsOpen, confirmReset, resetProgress]);

  const t = tracker.current;
  const sections = doc ? progressSections(doc) : [];
  const tocSections = sections.filter((s) => s.level >= 2).length > 0
    ? sections.filter((s) => s.level >= 2)
    : sections;
  const minutesLeft = doc ? Math.ceil(t.remainingWords() / wpm.current) : 0;
  const readCount = sections.filter((s) => t.progress.get(s.id)?.read).length;

  // Folder rollup + completion chaining
  const fileStateOf = (path: string) => filesState.current[path];
  const doneCount = docs.filter((d) => fileStateOf(d.path)?.completed).length;
  const folderMinutesLeft = Math.ceil(
    docs.reduce((sum, d) => {
      const st = fileStateOf(d.path);
      if (st?.completed) return sum;
      const remaining = Math.max(0, d.wordCount - (st?.readWords ?? 0));
      return sum + remaining;
    }, 0) / wpm.current,
  );
  const activeIndex = docs.findIndex((d) => d.path === active);
  const nextUp = justCompleted ? nextUnread(docs, filesState.current, activeIndex) : undefined;

  // Odometer + final-stretch marker + fill-the-circle ring
  const wordsPassed = doc ? Math.min(doc.wordCount, Math.round(t.passedWords())) : 0;
  const docFraction = doc ? Math.min(1, t.allRead() ? 1 : wordsPassed / Math.max(1, doc.wordCount)) : 0;
  const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
  const lastSectionId = sections.length > 0 ? sections[sections.length - 1].id : null;
  const finalStretch =
    !!doc && sections.length > 1 && !t.allRead() && activeSection === lastSectionId;

  // Pace line for the completion pill: sum of per-section traverse times.
  const readElapsedMs = sections.reduce((sum, s) => sum + (t.progress.get(s.id)?.dwellMs ?? 0), 0);
  const paceWpm = readElapsedMs > 30_000 && doc ? Math.round(doc.wordCount / (readElapsedMs / 60_000)) : 0;
  const paceOk = paceWpm >= 60 && paceWpm <= 900;
  const nth = (n: number) => (n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

  // Cheapest win: the smallest finishable thing in the folder (task initiation).
  const cheapest = (() => {
    if (docs.length < 2) return undefined;
    let best: { entry: DocEntry; min: number } | undefined;
    for (const entry of docs) {
      if (entry.path === active) continue;
      const st = fileStateOf(entry.path);
      if (st?.completed) continue;
      const remaining = Math.max(0, entry.wordCount - (st?.readWords ?? 0));
      if (remaining === 0) continue;
      const min = Math.max(1, Math.ceil(remaining / wpm.current));
      if (!best || min < best.min) best = { entry, min };
    }
    return best && best.min <= 15 ? best : undefined;
  })();

  const filteredDocs = filterQuery
    ? docs.filter((d) => d.path.toLowerCase().includes(filterQuery.toLowerCase()))
    : docs;
  const currentFavorite = favorites.some((favorite) => favorite.path === currentRoot);

  // Rollup flash on any completion; folder-clear moment when the set closes.
  useEffect(() => {
    if (prevDoneCount.current === -1) {
      prevDoneCount.current = doneCount;
      return;
    }
    if (doneCount > prevDoneCount.current) {
      setRollupFlash(true);
      setTimeout(() => setRollupFlash(false), 900);
      if (doneCount === docs.length && docs.length > 1 && !folderClearShown.current) {
        folderClearShown.current = true;
        const words = docs.reduce((sum, d) => sum + d.wordCount, 0);
        setFolderClear(`folder clear · ${docs.length} docs · ${words.toLocaleString()} words`);
        setTimeout(() => setFolderClear(null), 6000);
      }
    }
    prevDoneCount.current = doneCount;
  });

  const badgeFor = (entry: DocEntry) => {
    if (entry.path === active && doc) {
      // Live values for the open doc, not the last-persisted snapshot.
      if (t.allRead()) return <span class="file-state done">✓</span>;
      const words = t.readWords();
      if (words > 0) return <span class="file-state pct">{Math.min(99, Math.round((words / Math.max(1, doc.wordCount)) * 100))}%</span>;
      return <span class="file-state dot" />;
    }
    const st = fileStateOf(entry.path);
    if (st?.completed) return <span class="file-state done">✓</span>;
    if (st?.readWords) return <span class="file-state pct">{Math.min(99, Math.round((st.readWords / Math.max(1, entry.wordCount)) * 100))}%</span>;
    // Quick-win chip: untouched docs finishable in ≤5 min show the low door in.
    const quickMin = Math.ceil(entry.wordCount / wpm.current);
    if (entry.wordCount > 0 && quickMin <= 5) return <span class="file-state quick">~{quickMin} min</span>;
    return <span class="file-state dot" />;
  };

  return (
    <div class={`layout ${focusLevel >= 1 ? 'focus' : ''} ${focusLevel === 2 ? 'focus-dim' : ''}`}>
      <aside class="sidebar">
        <header class="brand">
          <span><span class="brand-mark">mark</span>read</span>
          <button
            class={`favorite-toggle ${currentFavorite ? 'saved' : ''}`}
            onClick={toggleFavorite}
            title={currentFavorite ? 'Remove this folder from saved folders' : 'Save this folder for quick reopening'}
            aria-label={currentFavorite ? 'Remove this folder from saved folders' : 'Save this folder for quick reopening'}
            aria-pressed={currentFavorite}
          >
            {currentFavorite ? '★' : '☆'}
          </button>
        </header>
        {(favorites.length > 0 || favoriteError) && (
          <section class="favorites" aria-label="Saved folders">
            <div class="favorites-title">saved folders</div>
            <div class="favorites-list">
              {favorites.map((favorite) => {
                const isCurrent = favorite.path === currentRoot;
                return (
                  <div key={favorite.path} class={`favorite-row ${isCurrent ? 'current' : ''}`}>
                    <button
                      class="favorite-open"
                      onClick={() => openFavorite(favorite.path)}
                      disabled={isCurrent}
                      title={favorite.path}
                    >
                      <span class="favorite-name">{favorite.name}</span>
                      {isCurrent && <span class="favorite-current">open</span>}
                    </button>
                    <button
                      class="favorite-remove"
                      onClick={() => forgetFavorite(favorite.path)}
                      title={`Remove ${favorite.name} from saved folders`}
                      aria-label={`Remove ${favorite.name} from saved folders`}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
            {favoriteError && <div class="favorite-error">{favoriteError}</div>}
          </section>
        )}
        {docs.length > 0 && (
          <div class={`folder-rollup ${rollupFlash ? 'flash' : ''}`}>
            {doneCount}/{docs.length} read
            {folderMinutesLeft > 0 && <span> · ~{folderMinutesLeft} min left</span>}
          </div>
        )}
        {cheapest && (
          <a class="cheapest-win" href={`#/${cheapest.entry.path}`}>
            closest to done: {cheapest.entry.name} · ~{cheapest.min} min
          </a>
        )}
        <input
          ref={filterInputRef}
          type="text"
          class="file-filter"
          placeholder="filter…"
          value={filterQuery}
          onInput={(event) => setFilterQuery((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              const match = filteredDocs[0];
              if (match) location.hash = `#/${match.path}`;
              setFilterQuery('');
              (event.target as HTMLInputElement).blur();
            } else if (event.key === 'Escape') {
              setFilterQuery('');
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
        <nav class="file-list">
          {filteredDocs.map((entry) => (
            <a
              key={entry.path}
              href={`#/${entry.path}`}
              class={`file-link ${entry.path === active ? 'active' : ''}`}
            >
              <span class="file-label">
                {entry.dir && <span class="file-dir">{entry.dir}/</span>}
                <span class="file-name">{entry.name}</span>
              </span>
              {badgeFor(entry)}
            </a>
          ))}
        </nav>
        <footer class="sidebar-foot">
          <span class="kbd-hint">? shortcuts</span>
          <button class="settings-toggle" onClick={() => setSettingsOpen((o) => !o)} title="Reading settings (s)">
            aa
          </button>
          <span class="theme-name">{theme}</span>
        </footer>
      </aside>

      {doc && sections.length > 0 && (
        <div class={`progress-bar ${justCompleted || folderClear ? 'complete' : ''}`} aria-hidden="true">
          {sections.map((s) => {
            const p = t.progress.get(s.id);
            const fill = t.fillFraction(s.id) * 100;
            const frontier = !p?.read && fill > 0 && fill < 100;
            return (
              <div key={s.id} class="progress-segment" style={{ flexGrow: Math.max(1, s.wordCount) }}>
                <div
                  class={`progress-fill ${p?.read ? 'read' : ''} ${frontier ? 'frontier' : ''}`}
                  style={{ transform: `scaleX(${fill / 100})` }}
                />
              </div>
            );
          })}
        </div>
      )}

      <main class="reading-pane">
        {doc ? (
          <>
            <div class="doc-meta">
              <div class="doc-meta-inner">
              <span class="doc-path">{doc.path}</span>
              <span class="doc-meta-right">
                {metaFlash && <span class="meta-flash" key={metaFlash}>{metaFlash}</span>}
                {finalStretch && <span class="final-stretch">final section</span>}
                <span class="doc-odometer">{wordsPassed.toLocaleString()} words</span>
                <span class="doc-minutes">
                  {minutesLeft <= 0 ? 'done' : `~${minutesLeft} min left`}
                </span>
                <button
                  class={`doc-reset ${confirmReset ? 'confirm' : ''}`}
                  title={confirmReset ? 'Confirm reset reading progress' : 'Reset reading progress'}
                  aria-label={confirmReset ? 'Confirm reset reading progress' : 'Reset reading progress'}
                  onClick={() => (confirmReset ? resetProgress() : setConfirmReset(true))}
                >
                  <span class="doc-reset-label doc-reset-icon" aria-hidden="true">↺</span>
                  <span class="doc-reset-label doc-reset-confirm" aria-hidden="true">reset progress?</span>
                </button>
              </span>
              </div>
            </div>
            <article ref={contentRef} class="doc-content" onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: doc.html }} />
            {resumeTop !== null && (
              <div class="resume-marker" style={{ top: `${resumeTop}px` }}>
                <span>you were here</span>
              </div>
            )}
            {justCompleted && (
              <div class="complete-pill">
                <span class="complete-check">✓</span> document complete
                {paceOk && (
                  <span class="complete-pace">
                    · ~{Math.max(1, Math.round(readElapsedMs / 60_000))} min · {paceWpm} wpm
                  </span>
                )}
                {sessionCompletions.current >= 2 && (
                  <span class="complete-chain">· {nth(sessionCompletions.current)} this session</span>
                )}
                {nextUp && (
                  <span class="complete-next">
                    · <kbd>n</kbd> next: {nextUp.name} (~{Math.max(1, Math.round((nextUp.wordCount - (fileStateOf(nextUp.path)?.readWords ?? 0)) / wpm.current))} min)
                  </span>
                )}
              </div>
            )}
          </>
        ) : (
          <div class="empty-state">
            <p>No markdown selected.</p>
          </div>
        )}
      </main>

      {doc && tocSections.length > 0 && (
        <nav class="toc">
          <div class="toc-header">
            {readCount}/{sections.length} sections
          </div>
          <div class="toc-items">
            {tocSections.map((s) => {
              const p = t.progress.get(s.id);
              return (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  class={`toc-item level-${s.level} ${s.id === activeSection ? 'active' : ''} ${p?.read ? 'read' : ''} ${s.id === nextUpId ? 'next-up' : ''}`}
                  onClick={(event) => {
                    event.preventDefault();
                    readerScrollToElement(document.getElementById(s.id));
                  }}
                >
                  <span class="toc-tick" />
                  <span class="toc-text">{s.text}</span>
                </a>
              );
            })}
          </div>
          <div class={`progress-ring ${ringPulse ? 'pulse' : ''} ${t.allRead() ? 'done' : ''}`} aria-hidden="true">
            <svg viewBox="0 0 120 120">
              <circle class="ring-track" cx="60" cy="60" r="54" />
              <circle
                class="ring-fill"
                cx="60"
                cy="60"
                r="54"
                style={{
                  strokeDasharray: RING_CIRCUMFERENCE,
                  strokeDashoffset: (1 - docFraction) * RING_CIRCUMFERENCE,
                }}
              />
            </svg>
            <div class="ring-label">
              <span class="ring-pct">{t.allRead() ? '✓' : `${Math.floor(docFraction * 100)}%`}</span>
              <span class="ring-sub">{t.allRead() ? 'done' : `~${minutesLeft} min left`}</span>
              <span class="ring-sub">{wordsPassed.toLocaleString()} words read</span>
            </div>
          </div>
        </nav>
      )}

      {folderClear && <div class="folder-clear-banner">{folderClear}</div>}

      {ruler !== 'off' && (
        <div class="reading-ruler" aria-hidden="true">
          {ruler === 'bar' && <div class="ruler-bar" />}
          {ruler === 'shade' && (
            <>
              <div class="ruler-shade-above" />
              <div class="ruler-shade-below" />
            </>
          )}
          {ruler === 'underline' && <div class="ruler-underline" />}
        </div>
      )}

      {helpOpen && (
        <div class="help-backdrop" onClick={() => setHelpOpen(false)}>
          <div class="help-card" onClick={(event) => event.stopPropagation()}>
            <div class="help-title">shortcuts</div>
            <dl class="help-list">
              <dt>j / k</dt><dd>scroll</dd>
              <dt>n / p</dt><dd>next / prev file</dd>
              <dt>[ / ]</dt><dd>prev / next section</dd>
              <dt>g / G</dt><dd>top / bottom</dd>
              <dt>f</dt><dd>focus mode</dd>
              <dt>r</dt><dd>reading ruler</dd>
              <dt>⇧R</dt><dd>reset progress (press twice)</dd>
              <dt>t</dt><dd>theme</dd>
              <dt>s</dt><dd>reading settings</dd>
              <dt>/</dt><dd>filter files</dd>
              <dt>?</dt><dd>toggle this help</dd>
              <dt>Esc</dt><dd>close / exit</dd>
            </dl>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div class="settings-card">
          <div class="settings-header">
            <span class="settings-title">reading settings</span>
            <button class="settings-close" onClick={() => setSettingsOpen(false)} title="Close (s / Esc)">
              ×
            </button>
          </div>

          <div class="settings-presets">
            {Object.keys(PRESETS).map((name) => (
              <button key={name} class="settings-preset" onClick={() => setSettings(PRESETS[name])}>
                {name}
              </button>
            ))}
            <button class="settings-reset" onClick={() => setSettings(DEFAULT_SETTINGS)}>
              reset
            </button>
          </div>

          <div class="settings-row">
            <span class="settings-label">font</span>
            <div class="settings-font-group">
              {FONT_CHOICES.map((f) => (
                <button
                  key={f}
                  class={`settings-font-btn ${settings.font === f ? 'active' : ''}`}
                  style={{ fontFamily: FONT_STACKS[f] }}
                  onClick={() => setSettings((s) => ({ ...s, font: f }))}
                >
                  {FONT_LABELS[f]}
                </button>
              ))}
            </div>
          </div>

          <div class="settings-row">
            <span class="settings-label">size</span>
            <div class="settings-stepper">
              <button
                disabled={settings.size <= 16}
                onClick={() => setSettings((s) => ({ ...s, size: clamp(s.size - 1, 16, 24) }))}
              >
                –
              </button>
              <span class="settings-value">{settings.size}px</span>
              <button
                disabled={settings.size >= 24}
                onClick={() => setSettings((s) => ({ ...s, size: clamp(s.size + 1, 16, 24) }))}
              >
                +
              </button>
            </div>
          </div>

          <div class="settings-row">
            <span class="settings-label">leading</span>
            <div class="settings-stepper">
              <button
                disabled={settings.leading <= 1.4}
                onClick={() => setSettings((s) => ({ ...s, leading: round2(clamp(s.leading - 0.05, 1.4, 1.9)) }))}
              >
                –
              </button>
              <span class="settings-value">{settings.leading.toFixed(2)}</span>
              <button
                disabled={settings.leading >= 1.9}
                onClick={() => setSettings((s) => ({ ...s, leading: round2(clamp(s.leading + 0.05, 1.4, 1.9)) }))}
              >
                +
              </button>
            </div>
          </div>

          <div class="settings-row">
            <span class="settings-label">measure</span>
            <div class="settings-stepper">
              <button
                disabled={settings.measure <= 55}
                onClick={() => setSettings((s) => ({ ...s, measure: clamp(s.measure - 1, 55, 80) }))}
              >
                –
              </button>
              <span class="settings-value">{settings.measure}ch</span>
              <button
                disabled={settings.measure >= 80}
                onClick={() => setSettings((s) => ({ ...s, measure: clamp(s.measure + 1, 55, 80) }))}
              >
                +
              </button>
            </div>
          </div>

          <div class="settings-row">
            <span class="settings-label">spacing</span>
            <div class="settings-spacing-group">
              {SPACING_CHOICES.map((sp) => (
                <button
                  key={sp}
                  class={`settings-spacing-btn ${settings.spacing === sp ? 'active' : ''}`}
                  onClick={() => setSettings((s) => ({ ...s, spacing: sp }))}
                >
                  {sp}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
