/**
 * Dwell tracking: a section counts as read only when time-in-viewport is
 * plausible for its word count — progress measures reading, not scrolling.
 */

export interface SectionMeta {
  id: string;
  text: string;
  level: number;
  wordCount: number;
}

export interface SectionProgress {
  dwellMs: number;
  read: boolean;
}

interface SectionBounds {
  id: string;
  top: number;
  bottom: number;
}

const TICK_MS = 1000;
/** Fraction of the nominal reading time that must be dwelled — forgiving
    enough for fast readers, strict enough that scrolling past earns nothing. */
const READ_THRESHOLD = 0.6;
const MIN_READ_MS = 3000;

export class DwellTracker {
  private sections: SectionMeta[] = [];
  private bounds: SectionBounds[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  progress = new Map<string, SectionProgress>();
  wpm = 238;
  dirty = false;
  onRead: (id: string) => void = () => {};
  onTick: () => void = () => {};

  expectedMs(section: SectionMeta): number {
    return Math.max(MIN_READ_MS, (section.wordCount / this.wpm) * 60_000 * READ_THRESHOLD);
  }

  setDoc(sections: SectionMeta[], saved: Record<string, SectionProgress>): void {
    this.sections = sections;
    this.progress = new Map(
      sections.map((s) => [s.id, saved[s.id] ?? { dwellMs: 0, read: false }]),
    );
    this.measure();
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

  /** The section whose range contains the reading line (30% down the viewport). */
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
    this.timer = setInterval(() => {
      if (document.hidden) return;
      // Credit dwell to sections overlapping the middle band of the viewport.
      const bandTop = window.scrollY + window.innerHeight * 0.1;
      const bandBottom = window.scrollY + window.innerHeight * 0.85;
      let changed = false;

      for (const b of this.bounds) {
        if (b.bottom < bandTop || b.top > bandBottom) continue;
        const section = this.sections.find((s) => s.id === b.id);
        const p = this.progress.get(b.id);
        if (!section || !p) continue;
        p.dwellMs += TICK_MS;
        this.dirty = true;
        changed = true;
        if (!p.read && p.dwellMs >= this.expectedMs(section)) {
          p.read = true;
          this.onRead(b.id);
        }
      }
      if (changed) this.onTick();
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Serializable snapshot for persistence. */
  snapshot(): Record<string, SectionProgress> {
    return Object.fromEntries(this.progress);
  }

  /** Words not yet read, with partial credit for dwell in progress. */
  remainingWords(): number {
    let remaining = 0;
    for (const s of this.sections) {
      const p = this.progress.get(s.id);
      if (!p || p.read) continue;
      const fraction = Math.min(1, p.dwellMs / this.expectedMs(s));
      remaining += s.wordCount * (1 - fraction);
    }
    return remaining;
  }
}
