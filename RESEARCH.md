# Research Findings

> Research phase completed 2026-07-08. Four deep-research workflow rounds; every claim below survived a 3-judge adversarial verification panel unless marked ⚠️ (source-attributed but panel rate-limited) . Verdict votes shown as `(3-0)` etc.

## Method

Each round ran: question decomposition → parallel web search → source fetch + claim extraction → 3-vote adversarial verification per claim (2/3 refutes kills a claim). Rounds:

- **A — Fact-check**: adversarial verification of 16 claims from the initial synthesis
- **B — Competitive landscape** (2025–2026)
- **C — Tech stack & architecture**
- **D — ADHD & gamification evidence base**

---

## Round A — Reading science & typography facts

### Confirmed

| Finding | Detail | Source |
|---|---|---|
| Bionic reading doesn't work (3-0) | Readwise study, 2,074 testers: **2.6 wpm slower** (−0.8%), comprehension identical (88% both conditions) | [Readwise blog](https://blog.readwise.io/bionic-reading-results/) |
| Bionic reading — eye-tracking replication (3-0) | Independent study: reading time *longer* with bionic formatting; comprehension/memorization inconclusive | [SAGE Open 2025](https://journals.sagepub.com/doi/10.1177/21582440251376158) |
| "Bionic Reading" is trademarked (3-0) | US Reg. 5557651 (2018, active), plus EU/UK/CA/JP/AU/CH | [Justia](https://trademarks.justia.com/792/12/bionic-79212988.html), [bionic-reading.com](https://bionic-reading.com/patent-trademark/) |
| RSVP/Spritz impairs comprehension (3-0) | Eliminating regressions (10–15% of reading time) lowers **literal** comprehension significantly; inferential/gist unaffected | [Psych. Science in the Public Interest](https://journals.sagepub.com/doi/full/10.1177/1529100615623267), [Computers in Human Behavior](https://www.sciencedirect.com/science/article/abs/pii/S0747563214007663), [PLOS ONE](https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0153786) |
| Reading speed norms (3-0) | Adults, English, silent reading: **238 wpm non-fiction, 260 wpm fiction** (meta-analysis, 190 studies, N=18,573) | [Brysbaert 2019](https://www.sciencedirect.com/science/article/abs/pii/S0749596X19300786) |
| Letter spacing helps dyslexic readers (3-0) | Extra-large letter spacing improves speed & accuracy immediately ("on the fly", no training); mechanism = visual crowding | [Zorzi et al., PNAS 2012](https://www.pnas.org/doi/10.1073/pnas.1205566109) |
| Font personalization is worth ~35% (3-0) | Individual's fastest vs. slowest of 16 fonts: **35% speed difference, zero comprehension loss** (N=352). **Font preference does not predict which font is fastest for a given reader** | [Wallace et al., ACM TOCHI 2022](https://dl.acm.org/doi/10.1145/3502222) |

### Corrections to initial assumptions

1. **WCAG line-height 1.5 is Level AAA** — SC 1.4.8 "Visual Presentation" (⚠️ W3C source, panel rate-limited). It is a *target*, not a baseline conformance requirement. [W3C Understanding 1.4.8](https://www.w3.org/WAI/WCAG21/Understanding/visual-presentation.html)
2. **The "20–35% Readability Consortium" figure is a composite.** The 35% is fonts-only (Wallace 2022); the ~20% traces to earlier Readability Matters text-format work. Google was a *later* consortium member, not a founder. Cite as: *"up to 35% individual speed variance across fonts (Wallace et al. 2022)."*
3. ⚠️ Literata: commissioned by Google for Play Books, variable font, Literata 3 under OFL ([Type Together](https://www.type-together.com/literata-font)) — authoritative source, panel rate-limited.
4. ⚠️ Edge Immersive Reader Line Focus offers exactly 1/3/5-line options ([Microsoft Support](https://support.microsoft.com/en-us/topic/use-immersive-reader-in-microsoft-edge-78a7a17d-52e1-47ee-b0ac-eff8539015e1)).

---

## Round B — Competitive landscape (2025–2026)

**Headline: the "AI-output reader" niche has entrants — demand is validated — but no product combines CLI-launch + browser + typography-first + reading progress + cross-platform.**

| Competitor | Category | Strengths | Gaps vs. us |
|---|---|---|---|
| [k1LoW/mo](https://github.com/k1LoW/mo) (3-0) | CLI→browser MD viewer | Sidebar, full-text search, Shiki, Mermaid, LaTeX, GitHub alerts, live-reload | No AI positioning, no reading ergonomics, no progress/gamification (3-0) |
| [mdts](https://github.com/unhappychoice/mdts) (3-0) | `npx mdts` zero-config preview | Explicitly lists "reviewing AI-generated docs" as use case | Preview tool, not a reader |
| [MacMD Viewer](https://macmdviewer.com/) (3-0) | Commercial macOS app | Purpose-built for Claude/ChatGPT/Copilot .md files; users cite Claude Code | macOS-only, not CLI-triggered, not browser |
| [MD+HTML Reader](https://www.producthunt.com/products/md-html-reader) (3-0) | Commercial macOS app (Tauri) | Read-only review of AI-generated MD/HTML in project folders | macOS-only, no CLI, no typography/ADHD focus (3-0) |
| [claude-code-log](https://github.com/daaain/claude-code-log) (3-0) | Python CLI → HTML transcripts | 1.1k ⭐, active (v1.4.0 June 2026) — proves demand for reading agent output | Transcript converter, not a folder reader |
| [glow](https://github.com/charmbracelet/glow) (3-0) | Terminal MD reader | The CLI-reading brand | Terminal-only, no browser rendering |
| [md-browse](https://github.com/WilliCommer/md-browse) (3-0) | npm CLI→browser | Serverless simplicity | Minimal; verifiers rejected the claim that its low star count proves the niche is only hobby projects (1-2) |
| Readwise Reader | Incumbent read-later app | Shipped CLI + MCP server (Mar 2026); Ghostreader AI (3-0) | Direction is reader→agent, not agent-output→reader; no local folder reading |

**Verified open territory** (2-1): existing CLI→browser tools are developer/README-focused (GitHub-styled HTML) rather than reading-optimized, typography-first, or ADHD-friendly — that positioning is open.

---

## Round C — Tech stack facts (25/25 confirmed, 0 refuted)

| Area | Verified finding | Source |
|---|---|---|
| Prior art | grip: Python server, GitHub API renderer, default port 6419 (3-0) | [grip](https://github.com/joeyespo/grip) |
| Browser open | `open` package delegates to `open`/`start`/`xdg-open` (3-0) | [sindresorhus/open](https://github.com/sindresorhus/open) |
| Port selection | `get-port`: preferred port(s) → random fallback (3-0) | [get-port](https://www.npmjs.com/package/get-port) |
| Binary distribution | Bun `--compile` works, cross-compiles all majors (3-0) — but ~56.8 MB/platform, ~422 MB full matrix (3-0) | [Bun docs](https://bun.com/docs/bundler/executables), [runspired](https://runspired.com/2025/01/25/npx-executables-with-bun.html) |
| npm binaries | Per-platform `optionalDependencies` + `os`/`cpu` fields is the standard; postinstall downloads unreliable (supply-chain, often disabled) (3-0) | [Sentry engineering](https://sentry.engineering/blog/publishing-binaries-on-npm) |
| CLI runtimes | Node slower cold-start than Go/Rust; Go/Rust win single-binary distribution (3-0) | [comparison](https://medium.com/@no-non-sense-guy/building-great-clis-in-2025-node-js-vs-go-vs-rust-e8e4bf7ee10e) |
| Markdown parsers | Comrak (Rust): 652/652 CommonMark, 670/670 GFM + footnotes etc. (3-0); markdown-wasm (md4c): 31 kB gzipped, zero deps (3-0) | [comrak](https://github.com/kivikakk/comrak), [markdown-wasm](https://github.com/rsms/markdown-wasm) |
| Shiki | Singleton highlighter (expensive to create); fine-grained imports; JS regex engine smaller/faster than WASM Oniguruma (all 3-0) | [Shiki perf guide](https://shiki.style/guide/best-performance) |
| Live reload | Vite HMR = WebSocket transport (3-0); MkDocs = HTTP long-polling + watchdog polling observer, 0.1 s debounce (3-0) | [Vite HMR API](https://vite.dev/guide/api-hmr), [MkDocs serve](https://deepwiki.com/mkdocs/mkdocs/4.3-serve-command) |

---

## Round D — ADHD & gamification evidence

### Confirmed

| Finding | Design implication | Source |
|---|---|---|
| Game-based interventions improve ADHD cognition: SMD 0.42 overall, **0.724 for attention** (20 RCTs, N=1,376, ages 7–15) (3-0) | Gamified attention support has a real evidence base (in children/interventions) | [PMC12751576](https://pmc.ncbi.nlm.nih.gov/articles/PMC12751576/) |
| ADHD: stronger delay aversion; **hypothetical/abstract rewards demotivate** (37 comparisons, N=3,763) (3-0) | Rewards must be immediate and concrete — real progress, not abstract points | [Marx et al. 2021](https://journals.sagepub.com/doi/abs/10.1177/1087054718772138) |
| **Delay aversion is heterogeneous**: only ~20% of ADHD children show classic steep discounting (3-0) | No single "ADHD mode" — personalization is the accessibility feature | [Nature Transl. Psychiatry 2025](https://www.nature.com/articles/s41398-025-03353-z) |
| Engagement decays once mechanics are mastered (3-0); adaptive difficulty critical (3-0) | Progress system must be *useful* (time-left, resume), not merely novel | [PMC12093074](https://pmc.ncbi.nlm.nih.gov/articles/PMC12093074/) |
| Reading rulers: +19/+16/+12 wpm for dyslexic readers (Grey Bar/Shade/Underline); **no comprehension effect; no effect for non-dyslexic readers** (3-0) | Optional, personalizable toggle (2–3 styles), never default-on | [CHI 2023](https://dl.acm.org/doi/fullHtml/10.1145/3544548.3581367) |
| Gamified reading app RCT: large academic gains (Cohen's d ≈ 1.0–1.3) (2-1) | Supportive but single study; treat as directional | [Frontiers in Education 2025](https://www.frontiersin.org/journals/education/articles/10.3389/feduc.2025.1668260/full) |

### Refuted by the verification panel

- ✗ (0-3) "80% of studies show attention improvements" — the source does not support this number.
- ✗ (1-2) Attribution of gains to *specific mechanics* (feedback/time pressure/difficulty) rather than the game medium generally.
- ✗ (1-2) The specific 550→440 ms reaction-time framing of the Frontiers RCT.

### Source-attributed, panel rate-limited (⚠️ treat as probable, cite carefully)

- TTS/read-aloud: small-to-moderate comprehension benefit, weighted d = .35 (22 studies) — [PMC5494021](https://pmc.ncbi.nlm.nih.gov/articles/PMC5494021/)
- Synced-highlight TTS: **no comprehension gain but 22/25 preferred it** (aphasia study) — engagement feature, honest framing — [PMC7959096](https://pmc.ncbi.nlm.nih.gov/articles/PMC7959096/)
- Increasing letter spacing **without matching word spacing decreased speed** in dyslexic readers — spacing presets must scale both proportionally — [PMC7188700](https://pmc.ncbi.nlm.nih.gov/articles/PMC7188700/)
- No single ruler design fits all; "no ruler" preferred by only 11.7% — [CHI 2023](https://dl.acm.org/doi/fullHtml/10.1145/3544548.3581367)

### Evidence caveats (bind on all product copy)

All clinical gamification evidence is from **children/adolescents in clinical interventions**, not adults reading documents. The product is **evidence-informed, not evidence-based** — never claim clinical validation.

---

## Strategic conclusions

1. **Cut permanently**: bionic reading (ineffective + trademarked), RSVP (harms comprehension).
2. **The wedge**: CLI-launched + browser-based + typography-first + progress/ADHD-friendly + cross-platform. Every verified competitor lacks ≥2 of these.
3. **Personalization is the product thesis**, doubly grounded: 35% individual font variance (typography) + ADHD heterogeneity (motivation).
4. **Rewards must be truthful, immediate, concrete** — abstract points are literally demotivating for the target audience.
5. **Time-left estimates**: default 238 wpm, calibrate per user from observed dwell.
