# Requirements — v1 Spec

> Working name: **md-reader** (CLI command TBD — see Open Questions). Grounded in [RESEARCH.md](./RESEARCH.md).

## Vision

A reader, not an editor. You run one command in a folder of Markdown — typically long, AI-generated documents — and get a browser reading experience with typography good enough that you never touch settings, and a progress system that makes finishing long documents *feel* as rewarding as it is.

**Positioning wedge** (verified open territory): CLI-launched + browser-based + typography-first + ADHD-friendly progress + cross-platform. Competitors have at most three of the five.

## Architecture

```
mdr [path]           # default: cwd
  └─ Node ≥20 TypeScript server (Bun-compatible)
       ├─ scans path recursively for .md (ignores node_modules, .git, hidden dirs)
       ├─ renders: markdown-it (GFM) + server-side Shiki (singleton, fine-grained langs)
       ├─ watches: chokidar → WebSocket push → live reload preserving scroll position
       ├─ serves SPA on get-port(preferred: 4400) and auto-opens browser (`open`)
       └─ persists state: ~/.mdreader/state.json (atomic writes)
            # sidecar JSON, not localStorage — ports change origins; CLI can read stats
```

- **Distribution**: npm (`npx`/global). No compiled binaries in v1 (57 MB/platform verified cost). No postinstall downloads (supply-chain).
- **Frontend**: Preact + Vite build, pre-built and shipped in the package (no build step at run time). Static, self-contained assets.
- **Mermaid & KaTeX**: client-side, lazy-loaded only when the rendered doc contains them.
- **Graceful shutdown**: Ctrl-C stops server; browser shows "session ended" state.

## Design principles (evidence-informed, binding)

1. **Progress is scroll-driven and predictable** — the reading line (80% down the viewport) leaves a high-water mark; a section is read when the line passes its end, the current section fills proportionally, and nothing grows while you sit still. (Dwell-based tracking was tried and rejected: multiple sections growing at once, and growth while idle, felt broken.)
2. **Rewards immediate, concrete, truthful** — every reward represents real reading done. No XP, points, levels, or leaderboards (abstract rewards demotivate the target audience — RESEARCH.md Round D).
3. **Celebrations ≤ 400 ms, non-blocking** — never a modal, never interrupts.
4. **Never punish** — no decay, no shame states, no "streak lost" red.
5. **Personalization is the ADHD feature** — no single "ADHD mode"; fast-feedback defaults + everything adjustable (delay-aversion heterogeneity).
6. **One keystroke to silence** — focus mode suppresses all game chrome.
7. **Honest copy** — "evidence-informed", never "clinically proven".

## P0 — v1 core

### 1. CLI
- `mdr [path]` (default `.`), `--port`, `--no-open`, `--help`, `--version`
- Recursive `.md`/`.markdown` discovery; ignore `node_modules`, `.git`, hidden dirs
- Port: prefer 4400, fall back via get-port; print URL; auto-open browser

### 2. Rendering
- GFM: tables, task lists, strikethrough, autolinks, footnotes
- Server-side Shiki: singleton highlighter, fine-grained language imports, JS regex engine, dual light/dark themes
- Mermaid + KaTeX lazy-loaded on detection
- Wide content (tables, code) scrolls in its own container — page never scrolls horizontally
- Sanitize rendered HTML (AI output is untrusted input)
- Target: 1 MB document renders < 1 s

### 3. Typography (defaults so good nobody opens settings)
| Property | Default | Rationale |
|---|---|---|
| Body font | **Literata** (variable, OFL, self-hosted) | Commissioned for long-form screen reading |
| Size / line-height | ~19 px / 1.6 | Medium-era long-form norms; WCAG 1.4.8 AAA target |
| Measure | ~68 ch max | 45–75 ch consensus; the rule every MD previewer breaks |
| Colors | Off-black `#1a1a1a`-ish on warm off-white; desaturated dark mode; sepia theme | Halation avoidance |
| Alignment | Left, ragged right; no justification | No good browser hyphenation |
| Paragraphs | Space-between (no indents) | Web convention; fits list-heavy AI text |
| UI font | System stack | Content is the star |

- Excellent `h1–h4` hierarchy, list, blockquote, table, code-block styling — AI text is structure-heavy
- Light / dark / sepia; respects `prefers-color-scheme`

### 4. Sidebar (the scoreboard)
- Folder tree of discovered files; current file highlighted
- Per-file read-state: unread ● / in-progress (n %) / done ✓
- Folder rollup: "3/8 read · ~42 min left"
- Filter files with `/`
- Collapsible (auto-hidden in focus mode)

### 5. Progress system (the differentiator)
- **Section chunking** by `h2`/`h3`
- **Scroll-driven section ticks**: hollow circle → filled tick in TOC when the reading line passes the section's end
- **Segmented progress bar**: one segment per section (goal-gradient: many small finish lines)
- **Time-left**: per section + per document; default 238 wpm, calibrated per user from observed reading speed
- **Furthest-read breadcrumb** in margin; **instant resume** to exact position on reopen
- **Doc-complete moment**: brief (≤400 ms) full-width acknowledgment; sidebar ✓; offer next unread file: "`n` → next: architecture.md (~6 min)"
- **TOC with scroll-spy** doubling as the quest log

### 6. Keyboard-first
`j/k` scroll · `n/p` next/prev file · `[`/`]` sections · `f` focus mode · `t` theme · `/` filter · `?` help overlay

### 7. Focus mode
- Level 1 (default `f`): hide sidebar + all chrome + all game elements
- Level 2 (toggle): dim all but current paragraph (iA Writer pattern)
- **Reading ruler**: optional, off by default, 2–3 styles (grey bar / shade / underline — the three with measured wpm gains for dyslexic readers), personalizable

### 8. Personalization panel
- Font: Literata / Atkinson Hyperlegible / system serif / system sans
- Size, line-height, measure: bounded sliders
- **"Relaxed spacing" preset**: letter *and* word spacing scaled proportionally (letter-only spacing measurably backfires)
- Named theme presets over raw controls (Apple Books pattern); custom persists

### 9. Live reload
- File change → WS push → re-render **preserving scroll position and read-state** (critical: AI agents rewrite files mid-read)

## P1 — post-v1
- Session summary card (Strava pattern: the summary is the reward)
- Stats page: reading heatmap (GitHub-contribution pattern), lifetime words/docs, personal records (records only ratchet up)
- Streaks with built-in 2-day grace; shown only while alive
- TTS with synced paragraph highlight (Web Speech API) — engagement framing, ⚠️ no comprehension claim
- Auto-scroll with adjustable pace
- Full-text search across folder
- "Calm mode": de-emphasize excessive inline bold (AI slop-formatting relief)
- Momentum indicator (subtle warm glow after N continuous minutes)

## P2 — exploratory
- Recall checkpoints (1 AI-generated question per doc — the only mechanic that could aid comprehension, not just engagement)
- Self-set folder quests with deadline bar
- Agent-native conventions (frontmatter status, MCP endpoint)

## Non-goals (v1)
Editing · cloud sync · accounts · annotations/highlight sync · plugins · mobile apps · **RSVP (never — harms comprehension)** · **bionic reading (never — ineffective + trademarked)** · abstract points/XP/leaderboards (never)

## Success criteria (dogfood on this repo's own docs)
- Cold start → first paint < 2 s; resume to exact position < 1 s
- 1 MB AI-generated report renders < 1 s and scrolls at 60 fps
- A first-time user changes zero settings and says the text "just looks right"
- You finish more of the documents your agents write

## Open questions
1. **Name + CLI command** — `mdr`? `mdread`? npm availability check needed
2. Default port (4400 placeholder; grip owns 6419, mdts 8521)
3. Include Lexend as a font option?
4. Bundle mermaid locally (offline, ~660 KB) vs. CDN — leaning local, lazy
5. Read-state format versioning in `state.json`
