import { posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
// @ts-expect-error no types published
import footnote from 'markdown-it-footnote';
// @ts-expect-error no types published
import taskLists from 'markdown-it-task-lists';
import githubAlerts from 'markdown-it-github-alerts';
import { katex } from '@mdit/plugin-katex';
import { createHighlighter, type Highlighter } from 'shiki';

/** Languages preloaded for highlighting — fine-grained set per Shiki perf guidance. */
const LANGS = [
  'typescript', 'javascript', 'tsx', 'jsx', 'json', 'bash', 'shell',
  'python', 'html', 'css', 'markdown', 'yaml', 'toml', 'sql', 'go',
  'rust', 'diff', 'dockerfile',
];

const THEMES = { light: 'vitesse-light', vesper: 'vesper', 'tokyo-night': 'tokyo-night' } as const;

export interface Heading {
  level: number;
  text: string;
  id: string;
  /** Words from this heading until the next heading (level ≤ 3). */
  wordCount: number;
}

export interface RenderedDoc {
  html: string;
  headings: Heading[];
  wordCount: number;
  title: string;
  hasMath: boolean;
}

/** Per-render context threaded through markdown-it's renderer rules. */
interface RenderEnv {
  /** Directory of the document being rendered, relative to the served root, `/`-separated, no trailing slash. */
  docDir: string;
}

let highlighter: Highlighter | undefined;
let md: MarkdownIt | undefined;

/** Minimal HTML escaping — safe for both attribute values and text content. */
function escapeHtml(str: string): string {
  return str.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] as string);
}

/**
 * Resolve an <img> src against the document's directory so relative images
 * resolve through the /raw/* static route. Absolute URLs (scheme:// or
 * protocol-relative //) and root-absolute paths are handled separately;
 * everything else is treated as relative to the document.
 */
function resolveImageSrc(src: string, docDir: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) return src;
  if (src.startsWith('/')) return `/raw${src}`;
  const joined = docDir ? posix.normalize(`${docDir}/${src}`) : posix.normalize(src);
  return `/raw/${joined}`;
}

/** Shiki highlighter is expensive — create once and reuse (singleton). */
export async function initRenderer(): Promise<void> {
  highlighter = await createHighlighter({
    themes: Object.values(THEMES),
    langs: LANGS,
  });

  md = new MarkdownIt({
    // Raw HTML disabled: AI-generated markdown is untrusted input.
    html: false,
    linkify: true,
    typographer: true,
    highlight: (code, lang) => {
      // Mermaid diagrams are rendered client-side (lazy-loaded, no CDN) —
      // skip Shiki and hand the raw source to the browser via a data attr.
      if (lang === 'mermaid') {
        return `<pre class="mermaid-src" data-diagram="${escapeHtml(code)}">${escapeHtml(code)}</pre>`;
      }
      if (!highlighter) return '';
      const language = highlighter.getLoadedLanguages().includes(lang) ? lang : 'text';
      return highlighter.codeToHtml(code, {
        lang: language,
        themes: THEMES,
        defaultColor: 'light',
      });
    },
  })
    .use(anchor, { slugify: slugify, tabIndex: false })
    .use(footnote)
    .use(taskLists, { enabled: false, label: true })
    .use(katex)
    // GitHub-style alerts (> [!NOTE] etc.) — no icons, mono label only, styled in styles.css.
    .use(githubAlerts, { icons: {} });

  // Relative image srcs resolve through /raw/* against the document's directory.
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIndex = token.attrIndex('src');
    if (srcIndex >= 0 && token.attrs) {
      token.attrs[srcIndex][1] = resolveImageSrc(token.attrs[srcIndex][1], (env as RenderEnv)?.docDir ?? '');
    }
    return self.renderToken(tokens, idx, options);
  };

  // External links open in a new tab; anchors and relative links are untouched.
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex('href');
    const href = hrefIndex >= 0 && token.attrs ? token.attrs[hrefIndex][1] : '';
    if (/^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener');
    }
    return self.renderToken(tokens, idx, options);
  };
}

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export function renderDoc(source: string, fileName: string, docDir = ''): RenderedDoc {
  if (!md) throw new Error('renderer not initialized — call initRenderer() first');

  const env: RenderEnv = { docDir };
  const tokens = md.parse(source, env);
  const html = md.renderer.render(tokens, md.options, env);

  // Extract heading outline from the parsed tokens (anchor plugin has set ids)
  // and attribute prose word counts to the section each word falls under.
  // Sections are bounded by headings of level ≤ 3; deeper headings fold into
  // their parent section.
  const headings: Heading[] = [];
  let inHeading = false;
  let currentSection: Heading | undefined;
  let preambleWords = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      inHeading = true;
      const level = Number(token.tag.slice(1));
      const text = tokens[i + 1]?.content ?? '';
      const heading: Heading = { level, text, id: token.attrGet('id') ?? slugify(text), wordCount: 0 };
      headings.push(heading);
      if (level <= 3) currentSection = heading;
    } else if (token.type === 'heading_close') {
      inHeading = false;
    } else if (!inHeading && token.type === 'inline' && token.content) {
      const words = (token.content.match(/\S+/g) ?? []).length;
      if (currentSection) currentSection.wordCount += words;
      else preambleWords += words;
    }
  }
  // Prose before the first heading belongs to the first section.
  if (headings.length > 0) headings[0].wordCount += preambleWords;

  const wordCount = countWords(source);
  const title = headings.find((h) => h.level === 1)?.text ?? fileName.replace(/\.(md|markdown)$/i, '');
  // KaTeX always emits a "katex" class (success or error span) — cheap presence check.
  const hasMath = html.includes('katex');

  return { html, headings, wordCount, title, hasMath };
}

export function countWords(source: string): number {
  // Strip code blocks so a code-heavy doc doesn't inflate the reading estimate.
  const prose = source.replace(/```[\s\S]*?```/g, ' ');
  return (prose.match(/\S+/g) ?? []).length;
}
