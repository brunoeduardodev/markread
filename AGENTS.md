# markread — Agent Handoff

> Exhaustive project handoff for any agent (or human) picking up this codebase.
> Last updated: 2026-08-27. Everything here was verified against the code at
> that date. Companion documents: [REQUIREMENTS.md](./REQUIREMENTS.md) (product
> spec), [RESEARCH.md](./RESEARCH.md) (evidence base with citations).

## 1. What this project is

**markread** is a CLI-launched, browser-based Markdown reader optimized for
long, AI-generated documents (agent reports, plans, generated docs, serialized
fiction). Run `markread [path]` → a local server scans the folder for `.md`
files → your browser opens a reading app with book-quality typography and a
gamified, ADHD-friendly progress system. It is deliberately a **reader, not an
editor** — there is no editing surface and none is planned.

**Positioning** (validated by adversarial web research in RESEARCH.md §Round B):
the combination *CLI-launched + browser-based + typography-first + reading
progress + cross-platform* is unoccupied. Known adjacent tools: `k1LoW/mo`
(CLI→browser viewer, no reading ergonomics), `mdts` (npx preview tool), MacMD
Viewer and MD+HTML Reader (commercial, macOS-only, no CLI). The npm package
name `markread` was verified available.

**Product principles** (binding, from REQUIREMENTS.md):
1. Progress is scroll-driven and predictable — nothing moves unless the reader moves.
2. Rewards are immediate, concrete, truthful. No XP, points, levels, leaderboards, or variable/surprise rewards, ever.
3. Celebrations ≤ 400 ms and non-blocking; the single exception is the user-invoked help/settings UI. No modals.
4. Never punish (no decay, no shame states, no red "streak lost").
5. Personalization *is* the accessibility feature (ADHD reward response is heterogeneous — see RESEARCH.md §Round D).
6. One keystroke (`f`) silences all game chrome.
7. Marketing/copy must say "evidence-informed", never "clinically proven".
8. AI-generated markdown is untrusted input (markdown-it `html: false`, mermaid `securityLevel: 'strict'`, path-traversal guards on every file-serving route).

## 2. Repository map

```
├── AGENTS.md              ← this file
├── REQUIREMENTS.md        ← product spec (kept current with decisions)
├── RESEARCH.md            ← ~75 verified research claims with citations
├── package.json           ← name "markread", bin "markread": dist/cli.js, ESM
├── tsconfig.json          ← server build (src → dist, NodeNext, strict)
├── vite.config.ts         ← web build (root: web/, outDir: ../dist/web, preact preset)
├── src/                   ← server (TypeScript ESM, built by tsc)
│   ├── cli.ts     (77 loc)  arg parsing, get-port(4400), open browser, SIGINT
│   ├── server.ts (208 loc)  Hono app: all routes, WebSocket, chokidar watcher
│   ├── render.ts (177 loc)  markdown-it pipeline + Shiki + heading extraction
│   ├── scan.ts    (45 loc)  recursive .md discovery
│   └── state.ts  (163 loc)  ~/.markread/state.json sidecar (atomic writes)
├── web/                   ← frontend (Preact + Vite, prebuilt into dist/web)
│   ├── index.html
│   ├── tsconfig.json      ← web typecheck (jsxImportSource preact, noEmit)
│   └── src/
│       ├── main.tsx   (13 loc)  fontsource imports + render(<App/>)
│       ├── app.tsx  (1139 loc)  THE component: all UI state and JSX
│       ├── progress.ts (188 loc) ProgressTracker (scroll-driven progress engine)
│       ├── enhance.ts  (65 loc)  lazy mermaid + KaTeX CSS post-render pass
│       ├── styles.css (1399 loc) entire design system
│       └── vite-env.d.ts        ambient `declare module '*.css'`
├── demo/                  ← committed example docs (see §10)
├── docs/screenshots/      ← committed UI screenshots (some predate current UI)
├── reading/               ← gitignored personal reading material (exists locally)
└── dist/                  ← build output (gitignored): cli.js etc + web/ assets
```

## 3. Commands

```bash
npm install
npm run build        # vite build (web → dist/web) && tsc (src → dist)
npm run typecheck    # server only
npx tsc -p web/tsconfig.json --noEmit   # web typecheck
node dist/cli.js [path] [--port N] [--no-open]   # run (dev flow: build first, no HMR setup)
```

There is no test suite yet (planned — see §11 Arc 7). There is no linter config.
The dev loop used throughout: `npm run build && pkill -f dist/cli.js && node
dist/cli.js . --port 4400 &`, then verify in a real browser.

## 4. Server architecture (src/)

### HTTP API (all JSON unless noted)

| Route | Purpose |
|---|---|
| `GET /api/tree` | `{ root, docs: [{path, name, dir, wordCount}], wpm }` — wordCount computed per file on each call (reads every file; fine at typical folder sizes) |
| `GET /api/doc?path=rel` | Renders one doc: `{ path, html, headings:[{level,text,id,wordCount}], wordCount, title, hasMath, minutes }`. Path-traversal guarded (`resolve` + `startsWith(root+sep)`), 404 unless `.md`/`.markdown` |
| `GET /api/state` | `{ wpm, settings, files }` for this server's root |
| `GET /api/favorites` | Globally persisted saved workspaces, most recently opened first |
| `POST /api/favorites` | Save the currently served root as a workspace favorite |
| `POST /api/favorites/open` | Switch to a previously saved root; never accepts an arbitrary filesystem path |
| `DELETE /api/favorites?path=abs` | Remove one saved workspace (does not affect its reading progress) |
| `POST /api/state/file` | Progress patch: `{ path, scrollY?, sections?, completed?, wordCount?, readWords?, wpmSamples?: number[] }`. Merge semantics in §5. Returns merged FileState + current `wpm`. Also receives `sendBeacon` on pagehide |
| `DELETE /api/state/file?path=rel` | Forget one file's progress entirely |
| `POST /api/state/settings` | Shallow-merge any object into global settings (forward-compatible); returns merged settings |
| `GET /raw/*` | Serves local images referenced by docs. Same traversal guard; extension whitelist (png jpg jpeg gif svg webp avif ico bmp); `cache-control: public, max-age=60` |
| `GET *` | SPA static assets from `dist/web` relative to the compiled `dist/cli.js` (`../dist/web` also resolves in tsx dev). Hashed assets → `immutable`; `index.html` → `no-cache` (this header matters: stale index.html serves dead bundle names) |

### Live reload
`chokidar` watches the root (ignores dotdirs/node_modules/dist and non-md
files). `change` → WS broadcast `{type:'change', path}` (client re-fetches the
open doc **preserving scroll** — critical because agents rewrite files
mid-read); `add`/`unlink` → `{type:'tree'}`. WebSocket server at path `/ws` on
the same HTTP server. Client auto-reconnects every 1s.

### Rendering pipeline (render.ts)
- markdown-it: `html:false` (security), `linkify`, `typographer`; plugins:
  markdown-it-anchor (ids via local `slugify`, auto-dedupes duplicates with
  `-1` suffixes), footnote, task-lists, `@mdit/plugin-katex` (server-side
  KaTeX, `$…$`/`$$…$$`), markdown-it-github-alerts (`icons:{}` = no icons).
- Shiki: singleton created once at startup; themes `vitesse-light`, `vesper`,
  `tokyo-night` rendered simultaneously as CSS variables
  (`--shiki-vesper`, `--shiki-tokyo-night`; light is the default color).
  Preloaded language list in `LANGS`; unknown langs fall back to `text`.
- ` ```mermaid ` fences bypass Shiki → `<pre class="mermaid-src"
  data-diagram="<escaped source>">` for client-side lazy rendering.
- Custom renderer rules: relative image srcs rewritten to `/raw/<docDir>/…`
  (scheme/data/protocol-relative untouched; root-absolute → `/raw/…`);
  `http(s)` links get `target="_blank" rel="noopener"`.
- **Heading extraction + per-section word counts**: sections are bounded by
  headings of level ≤ 3 (h4+ folds into its parent); prose words are counted
  from inline tokens outside headings and attributed to the current section;
  pre-first-heading words go to the first section. `countWords()` strips
  fenced code so code-heavy docs don't inflate estimates.
- `hasMath` = rendered html contains `"katex"`.

### State sidecar (state.ts)
File: `~/.markread/state.json`. Atomic writes (tmp + rename), 500 ms
debounced, flushed on server close. Corrupt/missing → fresh state, never
crash.

```jsonc
{
  "version": 1,
  "wpm": 238,              // Brysbaert 2019 default; recalculated as median of
  "wpmSamples": [],        // last 50 samples, ONLY once ≥5 samples, clamp 120–600
  "settings": {},          // reading typography prefs (see §7 Settings)
  "daily": {},             // RESERVED for P1 stats/heatmap: ISO date → {wordsRead, msRead}
  "favorites": [{          // globally saved workspace roots (independent of progress)
    "path": "/abs/folder",
    "name": "folder",
    "addedAt": 0,
    "lastOpenedAt": 0
  }],
  "roots": {
    "/abs/served/root": { "files": {
      "rel/path.md": {
        "scrollY": 0,          // last position (resume target)
        "sections": { "<heading-id>": { "dwellMs": 0, "read": false, "sampled": false } },
        "completed": false,    // sticky true
        "lastOpenedAt": 0,
        "wordCount": 0,
        "readWords": 0         // sticky max — drives sidebar %
      }
    }}
  }
}
```

Merge semantics (`patchFileState`): `scrollY` overwrites; `completed` is
sticky-true; `readWords` is sticky-max; per-section merge keeps max `dwellMs`
and sticky-true `read`/`sampled`. Progress can only regress via the DELETE
route. Note: `dwellMs` today stores the elapsed ms from a section's first
entry to being passed (used for WPM sampling + the pace line) — the name is a
holdover from the removed dwell system.

## 5. The progress model (web/src/progress.ts) — READ THIS FIRST

`ProgressTracker` is the heart of the product. Semantics:

- **Reading line** = `scrollY + innerHeight * 0.8`; when within 2px of max
  scroll it **snaps to `scrollHeight`** so the final section can complete.
- The line leaves a **high-water mark** (`furthest`). A section is **read**
  when `furthest >= section.bottom`. Exactly one "frontier" section is
  partially filled (`fillFraction` = proportional, capped at 0.96 until read).
  Scrolling back up never regresses anything.
- Nothing advances while idle — evaluation runs only on scroll events
  (rAF-throttled). This is a **deliberate product decision**: a dwell-based
  system (time-in-viewport) was built first and rejected by the owner because
  multiple visible sections growing at once, and growth while sitting still,
  read as broken. Do not reintroduce time-based fill.
- Section pixel bounds are re-measured on **every** evaluation (webfont load,
  live reload, and images shift layout; stale geometry once stranded ticks).
- On `setDoc`, `furthest` is initialized to max(reading line, bottom of every
  already-read section) — the first viewport of a fresh doc counts
  immediately (Kindle-like semantics).
- **WPM sampling**: when a section ≥ 80 words is passed, elapsed time from
  first entry → passed becomes a sample (`onSample`), sent with the next
  persist; server keeps median-of-50, active after 5 samples, clamped 120–600.
- Key callbacks: `onTick` (any advance), `onRead(id)`, `onSample(wpm)`.
  Useful methods: `passedWords()`, `remainingWords()`, `readWords()`,
  `allRead()`, `fillFraction(id)`, `currentSectionId()` (scroll-spy line at
  30% viewport), `snapshot()`.
- Debug: the live tracker instance is exposed as `window.__markread`.

## 6. The frontend (web/src/app.tsx — single component)

All state lives in one `App()` component. Notable mechanics:

- **Hash routing**: `#/rel/path.md`. In-doc anchors (`#footnote` etc.) are
  intercepted on the article and scrolled, so they don't break routing.
- **Resume**: `loadDoc` awaits the `/api/state` fetch (`stateReady` ref) before
  restoring scroll — do not remove this await; resume silently breaks
  (`history.scrollRestoration = 'manual'` so the browser can't mask it).
  A fading "you were here" dashed marker shows at the resume point (>400px).
- **Persistence**: every 3s while tracker is dirty + `sendBeacon` on pagehide +
  immediately on completion + flush when switching docs (effect cleanup on
  `active`). Local mirror `filesState.current` is updated on every persist so
  sidebar states are live.
- **Scrolling**:
  - `j`/`k` = velocity slide: hold → constant 170 px/s via rAF (`startSlide`/
    `stopSlide`), release (keyup) → instant stop; a short tap completes exactly
    one computed body line. Wheel/touch/window-blur cancels without adding a
    tap nudge, and natural input never issues a competing scroll command.
  - `g`/`G` and `[`/`]` are instant keyboard jumps. Pointer TOC and in-document
    anchor clicks remain browser-native smooth scroll; wheel/touch interrupts
    them, and `prefers-reduced-motion` makes pointer jumps immediate.
  - The segmented progress bar and ring track scroll directly without an
    interpolated tail; the bar uses compositor-friendly `scaleX`.
- **Keyboard map** (single guarded handler; INPUT/TEXTAREA targets and
  meta/ctrl/alt combos are ignored): `j/k` slide · `n/p` next/prev file (n
  jumps to next *unread* once current doc is completed) · `[/]` sections ·
  `g/G` top/bottom · `t` theme cycle · `f` focus cycle (0→1→2→0) · `r` ruler
  cycle · `⇧R` reset (two-step confirm shared with the ↺ button) · `/` focus
  file filter · `s` settings panel · `?` help overlay · `Esc` priority chain:
  help → settings → filter → focus.
- **Focus mode**: level 1 hides ALL chrome (sidebar, TOC+ring, progress bar,
  meta bar, pills, cues — "one keystroke to silence"); level 2 additionally
  dims every direct child of `.doc-content` except the `.current` block
  (nearest the 30% line, tracked in the scroll handler).
- **Reading ruler** (`r`, persisted in localStorage `markread:ruler`): fixed
  band centered at 38vh. Styles: `bar` (translucent strip), `shade` (dims all
  but a 9.6em ≈ 6-line window — size has been tuned by feel twice), `underline`.
- **Theme** (`t`, localStorage `markread:theme`): `light` / `vesper` /
  `tokyo-night` via `data-theme` on `<html>`; OS dark preference defaults to
  vesper.

### The dopamine layer (all in app.tsx; grep "Dopamine")

Cue inventory — all deterministic and derived from real progress:

| Cue | Trigger | Surface |
|---|---|---|
| Word odometer | every advance | sticky meta bar, plain digits |
| Frontier comet | while a segment is partially filled | box-shadow leading edge on the bar |
| Delta pulse `−N min` | section ≥50 words passed | `.meta-flash` (1.6s) |
| Next-up shimmer | same moment as delta | next TOC tick pulses (state `nextUpId`, NOT an imperative class — Preact re-renders clobber those) |
| Milestones `N% ·` | docs >20 min: every 10%; else 25/50/75 (100% = pill's job) | meta flash + ring pulse |
| `final section` | scroll-spy enters last section | persistent meta label |
| Completion pill | all sections read (first time) | `✓ document complete · read in ~N min · X wpm (only when elapsed >30s and 60–900wpm) · 2nd this session · n next: file (~N min)` |
| Ring hub | always (doc with sections) | 280px SVG circle at rail bottom: big %, `~N min left`, `N words read`; ✓/done when complete; pulses on milestones |
| Sidebar read-states | persisted + live for open doc | `●` unread / `N%` / `✓`; plus `~N min` quick-win chips on untouched docs ≤5 min |
| Folder rollup + flash | any completion | `N/M read · ~X min left`, accent flash on increment |
| Cheapest-win link | ≥2 docs, any unfinished ≤15 min | `closest to done: X · ~N min` under rollup |
| Folder-clear banner | last doc in folder completes (once per session) | the one big celebration |

**Cue governance** (do not weaken these):
- 8-second **celebration budget** (`tryCue`/`lastCueAt`) shared by
  sub-completion cues; **milestones bypass and claim it** (they outrank deltas);
  completion-level moments (pill, folder banner) are exempt.
- `suppressCues` ref is true during `setDoc` (doc load/reset): sections passed
  "for free" at load fire no cues and drain no budget.
- A read that completes the doc fires the pill only (no competing delta).
- Milestones behind a resume point are pre-marked shown, never re-celebrated
  (`milestonesShown` recomputed in `loadDoc` and in reset).
- Focus mode hides every one of these surfaces.

## 7. Design system (web/src/styles.css)

Identity: **"editorial broadsheet inside terminal chrome"** — Literata body,
IBM Plex Mono chrome, one warm accent reserved for progress/reward.

CSS variables on `:root` (overridden per `data-theme` and inline by settings):
`--paper --paper-raised --ink --ink-soft --ink-faint --rule --accent
--emphasis --link --marker --code --font-body --font-ui --measure --body-size
--body-leading --body-letter-spacing --body-word-spacing --sidebar-width(17rem)
--toc-width(22rem)`.

| Role | light | vesper | tokyo-night |
|---|---|---|---|
| paper / ink | `#faf6ef` / `#221f1a` | `#101010` / `#ededed` | `#1a1b26` / `#c0caf5` |
| accent (reward ONLY) | copper `#b4642d` | peach `#ffc799` | orange `#ff9e64` |
| bold (`--emphasis`) | bordeaux `#97352f` | peach | blue `#7aa2f7` |
| inline code (`--code`) | teal `#276e5d` | mint `#99ffe4` | green `#9ece6a` |
| links / markers | copper / copper | peach / peach | cyan `#7dcfff` / purple `#bb9af7` |

Rules that encode decisions: never pure black-on-white (halation); left-align,
never justify; 68ch default measure; inline code is unboxed colored semibold
mono (600) sized 0.85em; bold inside headings/blockquotes inherits (no color);
wide content (tables, code, math) scrolls in its own container — the page
never scrolls horizontally; Shiki theme switching via
`[data-theme='X'] .shiki span { color: var(--shiki-X) }`.

Settings (server-persisted via `POST /api/state/settings`, sanitized per-field
on hydration): `{ font: literata|atkinson|system-serif|system-sans, size:
16–24, leading: 1.4–1.9, measure: 55–80, spacing: normal|relaxed }`. Presets:
default/cozy/airy/compact. **Constraint**: `relaxed` scales letter AND word
spacing together — letter-only spacing measurably hurts reading (RESEARCH.md).

Layout: left sidebar 17rem (brand + save-folder star / saved-folder list / rollup / cheapest-win / filter / file list
/ footer with settings toggle + theme name) · center reading pane (sticky meta
bar top, article at measure, pills fixed bottom-center) · right rail 22rem
(TOC quest log scrolls, 280px ring pinned bottom). Fixed 4px segmented
progress bar spans the pane at viewport top. Breakpoints: <1180px hides rail
(+ring); <760px hides sidebar too.

## 8. Working conventions

- **Verify in a real browser before committing.** The loop used for every
  change here: `npm run build` → `pkill -9 -f dist/cli.js; node dist/cli.js .
  --no-open --port 4400 &` → drive the UI (Playwright or manually), assert the
  actual behavior (scroll positions, class changes, state file contents) → commit.
- Commit style: imperative subject, body explains the *why* and records
  verification; one logical change per commit.
- **Git delivery:** work directly on `main`; do not create feature branches.
  After verification, commit the completed change on `main` and push it with
  `git push master main`. If the `master` remote is unavailable or the push is
  rejected, report that fact and do not push to a different remote or branch.
- Multi-agent pattern that worked: an orchestrator specs arcs precisely (file
  boundaries, hard rules: no git/no builds/no servers, typecheck only) for
  worker agents on disjoint file surfaces, then wires the seams, verifies
  end-to-end, and commits.
- Design/copy tone: lowercase mono labels for chrome; celebrations are quiet,
  textual, and fast; when in doubt, less.

## 9. Known gotchas (each cost real debugging time)

1. **sendBeacon resurrection**: an open tab persists its full progress on
   unload. If you reset state via the API and then navigate/reload an old tab,
   the beacon re-completes the doc. When testing resets, use the in-page ↺ /
   `⇧R` flow, not out-of-band API calls.
2. **Stale index.html**: tabs cached before the `no-cache` header existed keep
   loading dead bundle names; one hard refresh fixes. When automating, add a
   `?v=N` cache-buster and confirm which bundle actually loaded before
   debugging "bugs".
3. **Imperative DOM classes get clobbered** by Preact re-renders (frequent:
   `progressVersion` bumps on every scroll advance). Transient UI must be
   state-driven (`nextUpId`, `ringPulse`, `metaFlash` all exist because of this).
4. **`loadDoc` must await `stateReady`** or resume races the state fetch and
   restores scroll 0 — and the browser's native scroll restoration will mask
   the bug in reload tests (that's why it's set to `'manual'`).
5. **Fixed-position centering** uses `calc()` with `--sidebar-width`/
   `--toc-width` (see `.complete-pill`, `.folder-clear-banner`) and needs the
   media-query variants updated if widths change.
6. Section bounds staleness: anything that changes layout after render
   (fonts, images, mermaid) is already handled by per-evaluation re-measure —
   keep it that way.
7. Playwright MCP screenshots land in the **repo root** (move or delete them;
   don't commit accidentally). `git add -A` once swept in a personal file —
   prefer explicit paths.
8. Multiple markread processes: port 4400 taken → next instance silently picks
   a random port and your curl/browser hits the OLD server. `pkill -9 -f
   dist/cli.js` first, then start, then verify the banner says 4400.

## 10. Demo content (`demo/`)

- `valkey-typescript-guide.md` — technical doc, code-heavy (Shiki torture test)
- `rendering-test.md` + `assets/diagram-test.svg` — mermaid, inline+block math,
  all five alerts, relative image, external link, wide table
- `chapter1_main.md`, `the-drowned-measure-chapter-01/02.md`, `-style.md`,
  `-word-hoard-01/02.md` — fiction shelf: long prose with few/no headings
  (exposes the single-section limitation, see backlog)

`reading/` is gitignored personal content; never commit it.

## 11. Backlog

### Arc 7 — Ship v0.1 (next up; the only release blocker)
- README.md: what/why, install (`npx markread` / `npm i -g markread`), usage,
  keyboard table, screenshots (retake — docs/screenshots predate the ring/rail).
- LICENSE (owner leaned MIT; confirm).
- Tests (vitest): scan (ignores, extensions), render (GFM features, heading
  word-count attribution, mermaid escaping, image src rewriting, link targets,
  hasMath), state (merge semantics, atomic write, wpm median gate), server
  (tree, doc, 404s, path traversal on /api/doc AND /raw, settings merge).
- Packaging sanity: `npm pack` → files field ships `dist` only; `npx` runs the
  bin; version 0.1.0; publish.

### P1 features (designed, not started)
- Stats page + GitHub-style reading heatmap + personal records (only ratchet
  up) — the `daily` state field has been reserved for this since Arc 1;
  nothing writes it yet.
- Streaks with built-in 2-day grace, shown only while alive; session summary
  card (Strava pattern); TTS with synced paragraph highlight (Web Speech API;
  engagement framing only — no comprehension claims, see RESEARCH.md); auto-
  scroll with adjustable pace; full-text search across the folder; "calm mode"
  (de-emphasize excessive AI bold); momentum glow after N continuous minutes.

### Smaller improvements (noted during use)
- Settings panel: ruler band size and j/k slide speed (both hand-tuned twice —
  170 px/s and 9.6em are personal-taste constants).
- Click a hollow TOC tick to manually mark a section read.
- Synthetic milestones/segments for heading-sparse docs (fiction chapters are
  one giant section — the bar and quest log go flat; ring/milestones carry it).
- Compact floating ring fallback below 1180px (rail+ring vanish there today).
- `markread --reset [path]` CLI flag.
- Live-reload during `npm run dev` (currently build-then-run, no HMR).

### Explicit non-goals (do not build)
Editing · cloud sync/accounts · annotations (v1) · plugins · mobile apps ·
RSVP/speed-reading (harms comprehension — RESEARCH.md) · bionic reading
(ineffective AND trademarked) · points/XP/leaderboards/variable rewards.
