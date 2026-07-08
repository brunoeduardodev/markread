import { useEffect, useState, useCallback, useRef } from 'preact/hooks';

interface DocEntry {
  path: string;
  name: string;
  dir: string;
}

interface Doc {
  path: string;
  html: string;
  headings: { level: number; text: string; id: string }[];
  wordCount: number;
  minutes: number;
  title: string;
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

export function App() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [active, setActive] = useState<string>(currentHashPath());
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const contentRef = useRef<HTMLElement>(null);

  const loadTree = useCallback(async () => {
    const res = await fetch('/api/tree');
    const data = await res.json();
    setDocs(data.docs);
  }, []);

  const loadDoc = useCallback(async (path: string, preserveScroll = false) => {
    if (!path) return;
    const scrollY = preserveScroll ? window.scrollY : 0;
    const res = await fetch(`/api/doc?path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const data: Doc = await res.json();
    setDoc(data);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  }, []);

  // Theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('markread:theme', theme);
  }, [theme]);

  // Initial load + hash routing
  useEffect(() => {
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
    loadDoc(active);
  }, [active, loadDoc]);

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

  // Keyboard: j/k scroll · n/p file nav · t theme
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      const index = docs.findIndex((d) => d.path === currentHashPath());
      if (event.key === 'j') smoothScrollBy(160);
      else if (event.key === 'k') smoothScrollBy(-160);
      else if (event.key === 'n' && index < docs.length - 1) location.hash = `#/${docs[index + 1].path}`;
      else if (event.key === 'p' && index > 0) location.hash = `#/${docs[index - 1].path}`;
      else if (event.key === 't') setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [docs]);

  return (
    <div class="layout">
      <aside class="sidebar">
        <header class="brand">
          <span class="brand-mark">mark</span>read
        </header>
        <nav class="file-list">
          {docs.map((entry) => (
            <a
              key={entry.path}
              href={`#/${entry.path}`}
              class={`file-link ${entry.path === active ? 'active' : ''}`}
            >
              {entry.dir && <span class="file-dir">{entry.dir}/</span>}
              <span class="file-name">{entry.name}</span>
            </a>
          ))}
        </nav>
        <footer class="sidebar-foot">
          <span class="kbd-hint">j/k scroll · n/p files · t theme</span>
          <span class="theme-name">{theme}</span>
        </footer>
      </aside>

      <main class="reading-pane">
        {doc ? (
          <>
            <div class="doc-meta">
              <span class="doc-path">{doc.path}</span>
              <span class="doc-minutes">~{doc.minutes} min</span>
            </div>
            <article
              ref={contentRef}
              class="doc-content"
              // Server renders with html:false — markdown-it output only, no raw HTML passthrough.
              dangerouslySetInnerHTML={{ __html: doc.html }}
            />
          </>
        ) : (
          <div class="empty-state">
            <p>No markdown selected.</p>
          </div>
        )}
      </main>
    </div>
  );
}
