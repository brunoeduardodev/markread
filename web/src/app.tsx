import { useEffect, useState, useCallback, useRef } from 'preact/hooks';
import { ProgressTracker, type SectionMeta, type SectionProgress } from './progress.js';

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

const THEMES = ['light', 'vesper', 'tokyo-night'] as const;
type Theme = (typeof THEMES)[number];

function initialTheme(): Theme {
  const stored = localStorage.getItem('markread:theme') as Theme | null;
  if (stored && THEMES.includes(stored)) return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'vesper' : 'light';
}

function currentHashPath(): string {
  return decodeURIComponent(location.hash.replace(/^#\//, ''));
}

/**
 * Butter scroller: j/k accumulate into a target position and a rAF loop
 * eases toward it (fixed fraction of remaining distance per frame).
 * Repeated/held keys extend the target instead of restarting an animation.
 */
// We own scroll restoration: resume comes from reading state, not the browser.
history.scrollRestoration = 'manual';

const scroller = { target: 0, active: false };

// The mouse always wins: any real scroll input cancels the keyboard glide,
// otherwise the rAF loop fights the wheel and drags the page back.
for (const cancelEvent of ['wheel', 'touchstart'] as const) {
  addEventListener(cancelEvent, () => (scroller.active = false), { passive: true });
}

function smoothScrollBy(delta: number) {
  if (!scroller.active) scroller.target = window.scrollY;
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  scroller.target = Math.max(0, Math.min(maxScroll, scroller.target + delta));
  if (scroller.active) return;

  scroller.active = true;
  const step = () => {
    if (!scroller.active) return; // cancelled by wheel/touch
    const remaining = scroller.target - window.scrollY;
    if (Math.abs(remaining) < 0.5) {
      window.scrollTo({ top: scroller.target, behavior: 'instant' });
      scroller.active = false;
      return;
    }
    window.scrollTo({ top: window.scrollY + remaining * 0.16, behavior: 'instant' });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
  // Bumped whenever dwell progress changes; cheap way to re-render TOC/bar.
  const [, setProgressVersion] = useState(0);

  const tracker = useRef(new ProgressTracker());
  // Dev affordance: inspectable from the browser console.
  (window as unknown as { __markread: ProgressTracker }).__markread = tracker.current;
  const filesState = useRef<Record<string, FileState>>({});
  const wpm = useRef(238);
  const docRef = useRef<Doc | null>(null);
  // Resolves once /api/state has been loaded — loadDoc must wait for it,
  // otherwise resume races the state fetch and silently restores to 0.
  const stateReady = useRef<Promise<void> | null>(null);
  // Observed reading-speed samples awaiting the next persist.
  const wpmQueue = useRef<number[]>([]);

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
  }, []);

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

    requestAnimationFrame(() => {
      const saved = filesState.current[path];
      const target = preserveScroll ? scrollBefore : (saved?.scrollY ?? 0);
      window.scrollTo({ top: target, behavior: 'instant' });

      const t = tracker.current;
      t.wpm = wpm.current;
      t.setDoc(progressSections(data), saved?.sections ?? {});
      t.start();
      setActiveSection(t.currentSectionId());
      setProgressVersion((v) => v + 1);

      // Re-entry cue: a fading "you were here" line at the resume point.
      if (!preserveScroll && target > 400) {
        setResumeTop(target + 32);
        setTimeout(() => setResumeTop(null), 4000);
      }
    });
  }, []);

  // Theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('markread:theme', theme);
  }, [theme]);

  // Initial load: tree + reading state. loadDoc awaits stateReady, so the
  // first document render always sees persisted progress.
  useEffect(() => {
    stateReady.current = fetch('/api/state')
      .then((r) => r.json())
      .then((stateRes) => {
        filesState.current = stateRes.files ?? {};
        wpm.current = stateRes.wpm ?? 238;
      })
      .catch(() => {});
    loadTree();

    const onHash = () => setActive(currentHashPath());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, [loadTree]);

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

  // Dwell → UI updates, completion detection, WPM samples
  useEffect(() => {
    const t = tracker.current;
    t.onTick = () => setProgressVersion((v) => v + 1);
    t.onRead = () => {
      setProgressVersion((v) => v + 1);
      const path = docRef.current?.path;
      if (path && t.allRead() && !filesState.current[path]?.completed) {
        setJustCompleted(true);
        persistProgress(path); // make the ✓ durable immediately
      }
    };
    t.onSample = (sample) => wpmQueue.current.push(sample);
    return () => t.stop();
  }, [persistProgress]);

  // Scroll-spy + section re-measure on resize
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setActiveSection(tracker.current.currentSectionId()));
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
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws`);
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'change' && msg.path === currentHashPath()) {
          loadDoc(msg.path, true); // preserve scroll — agents rewrite files mid-read
        } else if (msg.type === 'tree') {
          loadTree();
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
  }, [loadDoc, loadTree]);

  // In-document anchor links (footnotes, etc.) scroll instead of breaking
  // the #/file hash routing.
  const onArticleClick = useCallback((event: MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (href?.startsWith('#') && !href.startsWith('#/')) {
      event.preventDefault();
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  // Keyboard: j/k scroll · n/p file nav · t theme
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const path = currentHashPath();
      const index = docs.findIndex((d) => d.path === path);
      if (event.key === 'j') smoothScrollBy(160);
      else if (event.key === 'k') smoothScrollBy(-160);
      else if (event.key === 'n') {
        // Chain-loading: once the current doc is complete, n jumps to the
        // next unread doc; otherwise it's plain next-file.
        const target = filesState.current[path]?.completed
          ? nextUnread(docs, filesState.current, index)
          : docs[index + 1];
        if (target) location.hash = `#/${target.path}`;
      } else if (event.key === 'p' && index > 0) location.hash = `#/${docs[index - 1].path}`;
      else if (event.key === 't') setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [docs]);

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
    return <span class="file-state dot" />;
  };

  return (
    <div class="layout">
      <aside class="sidebar">
        <header class="brand">
          <span class="brand-mark">mark</span>read
        </header>
        {docs.length > 0 && (
          <div class="folder-rollup">
            {doneCount}/{docs.length} read
            {folderMinutesLeft > 0 && <span> · ~{folderMinutesLeft} min left</span>}
          </div>
        )}
        <nav class="file-list">
          {docs.map((entry) => (
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
          <span class="kbd-hint">j/k scroll · n/p files · t theme</span>
          <span class="theme-name">{theme}</span>
        </footer>
      </aside>

      {doc && sections.length > 0 && (
        <div class={`progress-bar ${justCompleted ? 'complete' : ''}`} aria-hidden="true">
          {sections.map((s) => {
            const p = t.progress.get(s.id);
            const fill = t.fillFraction(s.id) * 100;
            return (
              <div key={s.id} class="progress-segment" style={{ flexGrow: Math.max(1, s.wordCount) }}>
                <div class={`progress-fill ${p?.read ? 'read' : ''}`} style={{ width: `${fill}%` }} />
              </div>
            );
          })}
        </div>
      )}

      <main class="reading-pane">
        {doc ? (
          <>
            <div class="doc-meta">
              <span class="doc-path">{doc.path}</span>
              <span class="doc-minutes">
                {minutesLeft <= 0 ? 'done' : `~${minutesLeft} min left`}
              </span>
            </div>
            <article class="doc-content" onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: doc.html }} />
            {resumeTop !== null && (
              <div class="resume-marker" style={{ top: `${resumeTop}px` }}>
                <span>you were here</span>
              </div>
            )}
            {justCompleted && (
              <div class="complete-pill">
                <span class="complete-check">✓</span> document complete
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
          {tocSections.map((s) => {
            const p = t.progress.get(s.id);
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                class={`toc-item level-${s.level} ${s.id === activeSection ? 'active' : ''} ${p?.read ? 'read' : ''}`}
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                <span class="toc-tick" />
                <span class="toc-text">{s.text}</span>
              </a>
            );
          })}
        </nav>
      )}
    </div>
  );
}
