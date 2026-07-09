/**
 * Scroll-driven progress: the reading line (80% down the viewport) leaves a
 * high-water mark as you scroll. A section is read when the line has passed
 * its end; the section containing the line fills proportionally. Nothing
 * grows while you sit still — progress moves only when you do.
 */

export interface SectionMeta {
  id: string;
  text: string;
  level: number;
  wordCount: number;
}

export interface SectionProgress {
  /** Time from the reading line entering the section to passing it (ms). */
  dwellMs: number;
  read: boolean;
  /** Whether this section already contributed a WPM calibration sample. */
  sampled?: boolean;
}

interface SectionBounds {
  id: string;
  top: number;
  bottom: number;
}

/** Sections below this size are too noisy to calibrate reading speed from. */
const MIN_SAMPLE_WORDS = 80;
/** The reading line sits this far down the viewport. */
const LINE_FRACTION = 0.8;

export class ProgressTracker {
  private sections: SectionMeta[] = [];
  private bounds: SectionBounds[] = [];
  /** performance.now() when the line first entered each section. */
  private enteredAt = new Map<string, number>();
  private furthest = 0;
  private raf = 0;

  progress = new Map<string, SectionProgress>();
  wpm = 238;
  dirty = false;
  onRead: (id: string) => void = () => {};
  onTick: () => void = () => {};
  /** Fired with an observed words-per-minute when a section is passed. */
  onSample: (wpm: number) => void = () => {};

  private readonly onScroll = () => {
    this.dirty = true; // any movement is worth persisting (resume position)
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.evaluate());
  };

  /** Document-coordinate position of the reading line. Snaps to the end of
      the document at max scroll so the final section can complete. */
  private readingLine(): number {
    const scrollHeight = document.documentElement.scrollHeight;
    const maxScroll = scrollHeight - window.innerHeight;
    if (window.scrollY >= maxScroll - 2) return scrollHeight;
    return window.scrollY + window.innerHeight * LINE_FRACTION;
  }

  setDoc(sections: SectionMeta[], saved: Record<string, SectionProgress>): void {
    this.sections = sections;
    this.progress = new Map(
      sections.map((s) => [s.id, saved[s.id] ?? { dwellMs: 0, read: false }]),
    );
    this.enteredAt.clear();
    this.measure();
    // High-water mark: past the end of every already-read section, and at
    // least the current (restored) reading line.
    this.furthest = this.readingLine();
    for (const b of this.bounds) {
      if (this.progress.get(b.id)?.read) this.furthest = Math.max(this.furthest, b.bottom);
    }
    this.evaluate();
  }

  /** Compute section pixel ranges from the rendered headings. */
  measure(): void {
    this.bounds = [];
    for (let i = 0; i < this.sections.length; i++) {
      const el = document.getElementById(this.sections[i].id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top + window.scrollY;
      const nextEl = i + 1 < this.sections.length
        ? document.getElementById(this.sections[i + 1].id)
        : null;
      const bottom = nextEl
        ? nextEl.getBoundingClientRect().top + window.scrollY
        : document.documentElement.scrollHeight;
      this.bounds.push({ id: this.sections[i].id, top, bottom });
    }
  }

  private evaluate(): void {
    // Layout shifts (webfont load, live reload) must never strand a section
    // on stale geometry — re-measure on every evaluation; it's cheap.
    this.measure();
    const line = this.readingLine();
    const advanced = line > this.furthest;
    if (advanced) this.furthest = line;

    for (const b of this.bounds) {
      const p = this.progress.get(b.id);
      if (!p) continue;
      if (this.furthest > b.top && !this.enteredAt.has(b.id)) {
        this.enteredAt.set(b.id, performance.now());
      }
      if (!p.read && this.furthest >= b.bottom) {
        p.read = true;
        this.dirty = true;
        const section = this.sections.find((s) => s.id === b.id);
        const enteredAt = this.enteredAt.get(b.id);
        if (section && enteredAt !== undefined) {
          const elapsed = performance.now() - enteredAt;
          p.dwellMs = Math.round(elapsed);
          if (!p.sampled && section.wordCount >= MIN_SAMPLE_WORDS) {
            p.sampled = true;
            this.onSample(section.wordCount / (elapsed / 60_000));
          }
        }
        this.onRead(b.id);
      }
    }
    if (advanced) this.onTick();
  }

  /** 0..1 fill for a section: read → 1, line inside → proportional, else 0. */
  fillFraction(id: string): number {
    if (this.progress.get(id)?.read) return 1;
    const b = this.bounds.find((bound) => bound.id === id);
    if (!b || this.furthest <= b.top) return 0;
    return Math.min(0.96, (this.furthest - b.top) / Math.max(1, b.bottom - b.top));
  }

  /** The section whose range contains the scroll-spy line (30% down). */
  currentSectionId(): string | null {
    const line = window.scrollY + window.innerHeight * 0.3;
    for (const b of this.bounds) {
      if (line >= b.top && line < b.bottom) return b.id;
    }
    return this.bounds.length && line >= this.bounds[this.bounds.length - 1].top
      ? this.bounds[this.bounds.length - 1].id
      : null;
  }

  start(): void {
    this.stop();
    addEventListener('scroll', this.onScroll, { passive: true });
  }

  stop(): void {
    removeEventListener('scroll', this.onScroll);
    cancelAnimationFrame(this.raf);
  }

  /** Serializable snapshot for persistence. */
  snapshot(): Record<string, SectionProgress> {
    return Object.fromEntries(this.progress);
  }

  /** Words in sections marked read. */
  readWords(): number {
    return this.sections.reduce(
      (sum, s) => sum + (this.progress.get(s.id)?.read ? s.wordCount : 0),
      0,
    );
  }

  allRead(): boolean {
    return this.sections.length > 0 && this.sections.every((s) => this.progress.get(s.id)?.read);
  }

  /** Words not yet passed, with partial credit for the section in progress. */
  remainingWords(): number {
    return this.sections.reduce((sum, s) => {
      return sum + s.wordCount * (1 - this.fillFraction(s.id));
    }, 0);
  }
}
