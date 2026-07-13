/**
 * Post-render enhancement pass for `.doc-content` — handles the pieces of a
 * rendered document that need browser JS and shouldn't block the initial
 * paint: Mermaid diagrams (rendered client-side, lazy-loaded, no CDN) and
 * KaTeX's stylesheet (loaded once a document actually contains math).
 *
 * The orchestrator (app.tsx) is expected to call this:
 *   - after setting the doc HTML (dangerouslySetInnerHTML) for a newly
 *     loaded document, once the container is in the DOM
 *   - again, on the same container, whenever the theme changes (so Mermaid
 *     diagrams re-render in the new light/dark palette)
 *
 * Both call sites should await the returned promise if they need to know
 * when enhancement has settled, but neither needs to — this function never
 * throws (per-diagram failures are caught and degrade to a source dump).
 */

export type EnhanceTheme = 'light' | 'vesper' | 'tokyo-night';

let katexCssLoaded = false;
let nextDiagramId = 0;

export async function enhanceDoc(container: HTMLElement, theme: EnhanceTheme): Promise<void> {
  const diagrams = Array.from(container.querySelectorAll<HTMLElement>('.mermaid-src'));
  if (diagrams.length > 0) {
    await renderMermaidDiagrams(diagrams, theme);
  }

  if (!katexCssLoaded && container.querySelector('.katex')) {
    katexCssLoaded = true;
    await import('katex/dist/katex.min.css');
  }
}

async function renderMermaidDiagrams(diagrams: HTMLElement[], theme: EnhanceTheme): Promise<void> {
  let mermaid: typeof import('mermaid').default;
  try {
    ({ default: mermaid } = await import('mermaid'));
  } catch {
    return; // offline/blocked chunk — leave the source <pre> visible
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'vesper' || theme === 'tokyo-night' ? 'dark' : 'neutral',
  });

  for (const el of diagrams) {
    // Always re-render from the original source so theme switches are exact,
    // not a re-theme of already-rendered SVG.
    const source = el.dataset.diagram ?? el.textContent ?? '';
    const id = `mermaid-diagram-${nextDiagramId++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      el.innerHTML = svg;
    } catch {
      // Bad/unsupported diagram source — fall back to a plain source dump
      // instead of leaving a broken half-rendered node in the DOM.
      el.classList.remove('mermaid-src');
      el.removeAttribute('data-diagram');
      el.textContent = source;
    }
  }
}
