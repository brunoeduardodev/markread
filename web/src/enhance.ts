/**
 * Post-render enhancement pass for `.doc-content` — handles the pieces of a
 * rendered document that need browser JS and shouldn't block the initial
 * paint: Mermaid diagrams (rendered client-side, lazy-loaded, no CDN) and
 * KaTeX's stylesheet (loaded once a document actually contains math).
 *
 * Mermaid source always stays on the original placeholder's `data-diagram`
 * attribute. That gives theme switches and the expanded viewer a trusted,
 * immutable source to render again instead of trying to recolor generated SVG.
 */

export type EnhanceTheme = 'light' | 'vesper' | 'tokyo-night';

interface MermaidPalette {
  background: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textSoft: string;
  textFaint: string;
  rule: string;
  structure: string;
}

const MERMAID_PALETTES: Record<EnhanceTheme, MermaidPalette> = {
  light: {
    background: '#faf6ef',
    surface: '#f3eee4',
    surfaceAlt: '#faf6ef',
    text: '#221f1a',
    textSoft: '#6b6459',
    textFaint: '#a89f90',
    rule: '#e5ddcd',
    structure: '#a89f90',
  },
  vesper: {
    background: '#000000',
    surface: '#161616',
    surfaceAlt: '#232323',
    text: '#ededed',
    textSoft: '#9b9b9b',
    textFaint: '#5e5e5e',
    rule: '#232323',
    structure: '#ff9e64',
  },
  'tokyo-night': {
    background: '#1a1b26',
    surface: '#16161e',
    surfaceAlt: '#292e42',
    text: '#c0caf5',
    textSoft: '#8189b5',
    textFaint: '#565f89',
    rule: '#292e42',
    structure: '#565f89',
  },
};

const EXPAND_ICON = `
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M6 2H2v4M10 2h4v4M14 10v4h-4M2 10v4h4" />
  </svg>`;

let katexCssLoaded = false;
let nextDiagramId = 0;
let nextRenderVersion = 0;
let mermaidQueue: Promise<void> = Promise.resolve();

export async function enhanceDoc(container: HTMLElement, theme: EnhanceTheme): Promise<void> {
  const diagrams = Array.from(container.querySelectorAll<HTMLElement>('.mermaid-src'));
  if (diagrams.length > 0) {
    await Promise.all(diagrams.map((diagram) => enhanceMermaidDiagram(diagram, theme)));
  }

  if (!katexCssLoaded && container.querySelector('.katex')) {
    katexCssLoaded = true;
    await import('katex/dist/katex.min.css');
  }
}

/** Render one Mermaid source into an arbitrary viewer surface. */
export async function renderMermaidInto(
  container: HTMLElement,
  source: string,
  theme: EnhanceTheme,
): Promise<boolean> {
  const version = String(nextRenderVersion++);
  container.dataset.mermaidRender = version;
  container.classList.remove('mermaid-error');
  container.setAttribute('aria-busy', 'true');

  try {
    const svg = await renderMermaidSvg(source, theme);
    if (!container.isConnected || container.dataset.mermaidRender !== version) return false;
    container.innerHTML = svg;
    container.classList.add('mermaid-rendered');
    container.removeAttribute('aria-busy');
    return true;
  } catch {
    if (!container.isConnected || container.dataset.mermaidRender !== version) return false;
    container.textContent = source;
    container.classList.remove('mermaid-rendered');
    container.classList.add('mermaid-error');
    container.removeAttribute('aria-busy');
    return false;
  }
}

async function enhanceMermaidDiagram(diagram: HTMLElement, theme: EnhanceTheme): Promise<void> {
  const source = diagram.dataset.diagram ?? diagram.textContent ?? '';
  ensureDiagramFrame(diagram);
  diagram.classList.add('mermaid-canvas');
  diagram.setAttribute('role', 'img');
  diagram.setAttribute('aria-label', 'Mermaid diagram');
  await renderMermaidInto(diagram, source, theme);
}

function ensureDiagramFrame(diagram: HTMLElement): void {
  if (diagram.closest('.mermaid-diagram')) return;

  const frame = document.createElement('figure');
  frame.className = 'mermaid-diagram';

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'mermaid-expand';
  expand.dataset.expandMermaid = '';
  expand.title = 'Maximize diagram';
  expand.setAttribute('aria-label', 'Maximize diagram');
  expand.innerHTML = EXPAND_ICON;

  diagram.before(frame);
  frame.append(diagram, expand);
}

function renderMermaidSvg(source: string, theme: EnhanceTheme): Promise<string> {
  let result = '';

  // Mermaid configuration is global. Serialize renders so two theme changes
  // cannot race and color a diagram with the previous theme's configuration.
  const render = mermaidQueue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    const palette = MERMAID_PALETTES[theme];

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      themeVariables: {
        darkMode: theme !== 'light',
        background: palette.background,
        mainBkg: palette.surface,
        primaryColor: palette.surface,
        primaryTextColor: palette.text,
        primaryBorderColor: palette.structure,
        secondaryColor: palette.surfaceAlt,
        secondaryTextColor: palette.text,
        secondaryBorderColor: palette.structure,
        tertiaryColor: palette.background,
        tertiaryTextColor: palette.textSoft,
        tertiaryBorderColor: palette.rule,
        textColor: palette.text,
        lineColor: palette.structure,
        titleColor: palette.text,
        edgeLabelBackground: palette.background,
        clusterBkg: palette.background,
        clusterBorder: palette.rule,
        noteBkgColor: palette.surface,
        noteTextColor: palette.text,
        noteBorderColor: palette.structure,
        actorBkg: palette.surface,
        actorBorder: palette.structure,
        actorTextColor: palette.text,
        actorLineColor: palette.textSoft,
        signalColor: palette.structure,
        signalTextColor: palette.text,
        labelBoxBkgColor: palette.surface,
        labelBoxBorderColor: palette.structure,
        labelTextColor: palette.text,
        loopTextColor: palette.text,
        activationBkgColor: palette.surfaceAlt,
        activationBorderColor: palette.structure,
      },
    });

    const id = `mermaid-diagram-${nextDiagramId++}`;
    ({ svg: result } = await mermaid.render(id, source));
  });

  mermaidQueue = render.catch(() => undefined);
  return render.then(() => result);
}
