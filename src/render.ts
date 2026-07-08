import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
// @ts-expect-error no types published
import footnote from 'markdown-it-footnote';
// @ts-expect-error no types published
import taskLists from 'markdown-it-task-lists';
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
}

export interface RenderedDoc {
  html: string;
  headings: Heading[];
  wordCount: number;
  title: string;
}

let highlighter: Highlighter | undefined;
let md: MarkdownIt | undefined;

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
    .use(taskLists, { enabled: false, label: true });
}

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

export function renderDoc(source: string, fileName: string): RenderedDoc {
  if (!md) throw new Error('renderer not initialized — call initRenderer() first');

  const env = {};
  const tokens = md.parse(source, env);
  const html = md.renderer.render(tokens, md.options, env);

  // Extract heading outline from the parsed tokens (anchor plugin has set ids).
  const headings: Heading[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === 'heading_open') {
      const level = Number(token.tag.slice(1));
      const inline = tokens[i + 1];
      const text = inline?.content ?? '';
      headings.push({ level, text, id: token.attrGet('id') ?? slugify(text) });
    }
  }

  const wordCount = countWords(source);
  const title = headings.find((h) => h.level === 1)?.text ?? fileName.replace(/\.(md|markdown)$/i, '');

  return { html, headings, wordCount, title };
}

function countWords(source: string): number {
  // Strip code blocks so a code-heavy doc doesn't inflate the reading estimate.
  const prose = source.replace(/```[\s\S]*?```/g, ' ');
  return (prose.match(/\S+/g) ?? []).length;
}
