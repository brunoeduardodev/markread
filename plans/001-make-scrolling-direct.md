# 001 — Make scrolling direct and predictable

- **Status**: DONE
- **Commit**: 2734042
- **Severity**: HIGH
- **Category**: Purpose & frequency, interruptibility, performance
- **Estimated scope**: 2 source files, about 45 changed lines

## Problem

Four interactions make the reader feel disconnected from input.

First, `web/src/app.tsx:148` issues an extra scroll command on every natural
wheel and touch-start event:

```ts
// web/src/app.tsx:148 — current
for (const cancelEvent of ['wheel', 'touchstart'] as const) {
  addEventListener(cancelEvent, () => {
    stopSlide();
    window.scrollTo({ top: window.scrollY, behavior: 'instant' });
  }, { passive: true });
}
```

That command runs even when no programmatic scroll is active, so ordinary
trackpad, wheel, and touch input can receive a competing page-level scroll.

Second, high-frequency keyboard navigation is animated. The `[`/`]` section
jumps and `g`/`G` document jumps at `web/src/app.tsx:751` share the same smooth
helpers used by pointer navigation:

```ts
// web/src/app.tsx:751 — current
} else if (event.key === '[' || event.key === ']') {
  // ...section lookup...
  readerScrollToElement(document.getElementById(headingSections[nextIdx].id));
} else if (event.key === 'g') smoothScrollTo(0);
else if (event.key === 'G') smoothScrollTo(document.documentElement.scrollHeight);
```

Keyboard actions can happen hundreds of times per day. They must complete
immediately; an animated tail makes the viewport feel behind the command.

Third, `j`/`k` taps do not fulfill the documented one-line nudge. Movement is
only the elapsed time before keyup multiplied by 170 px/s, so a short tap can
move nearly zero pixels and varies with key duration and frame scheduling:

```ts
// web/src/app.tsx:162 — current
const SLIDE_PX_PER_S = 170;
const slide = { dir: 0 as -1 | 0 | 1, raf: 0, lastT: 0 };

// web/src/app.tsx:172 — current
const step = (t: number) => {
  if (slide.dir === 0) return;
  const dt = Math.min(64, t - slide.lastT) / 1000;
  slide.lastT = t;
  window.scrollBy({ top: slide.dir * SLIDE_PX_PER_S * dt, behavior: 'instant' });
  slide.raf = requestAnimationFrame(step);
};
```

Fourth, scroll-derived progress continues animating after the reader stops.
The segmented bar transitions a layout property for 150ms, and the ring trails
for 200ms:

```css
/* web/src/styles.css:393 — current */
.progress-fill {
  height: 100%;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
  transition: width 150ms ease-out;
}

/* web/src/styles.css:678 — current */
.ring-fill {
  /* ... */
  transition: stroke-dashoffset 200ms ease-out;
}
```

```tsx
// web/src/app.tsx:1000 — current
<div
  class={`progress-fill ${p?.read ? 'read' : ''} ${frontier ? 'frontier' : ''}`}
  style={{ width: `${fill}%` }}
/>
```

Progress is a direct representation of scroll position. Interpolation makes it
less truthful and animating `width` adds layout work during the hottest input
path.

## Target

Natural reader input owns the viewport. Wheel and touch-start cancel the
`j`/`k` slide without issuing another scroll operation:

```ts
for (const cancelEvent of ['wheel', 'touchstart'] as const) {
  addEventListener(cancelEvent, () => stopSlide(), { passive: true });
}
```

Keep pointer-triggered TOC and in-document anchor navigation exactly as it is:
`readerScrollToElement()` remains browser-smooth when motion is allowed and
instant under `prefers-reduced-motion`. Add separate instant helpers for
keyboard navigation:

```ts
function readerJumpTo(y: number) {
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
  window.scrollTo({
    top: Math.max(0, Math.min(maxScroll, y)),
    behavior: 'instant',
  });
}

function readerJumpToElement(element: HTMLElement | null) {
  if (!element) return;
  element.scrollIntoView({ block: 'start', behavior: 'instant' });
}
```

Use `readerJumpToElement()` for `[`/`]` and `readerJumpTo()` for `g`/`G`.
Delete the now-unused `readerScrollTo()` and `smoothScrollTo()` functions.
Do not change TOC clicks or article anchor clicks.

Preserve the settled 170 px/s direct-control slide. Track how far a press has
moved, and only on a genuine `j`/`k` keyup complete a short press to exactly one
computed body line:

```ts
const SLIDE_PX_PER_S = 170;
const slide = { dir: 0 as -1 | 0 | 1, raf: 0, lastT: 0, distance: 0 };

function readerLineHeight() {
  const lineHeight = Number.parseFloat(getComputedStyle(document.body).lineHeight);
  return Number.isFinite(lineHeight) ? lineHeight : 0;
}
```

Set `slide.distance = 0` when a new slide begins. In each animation frame,
calculate one `delta`, add `Math.abs(delta)` to `slide.distance`, and scroll by
that `delta`. Change the stop function to distinguish keyup from cancellation:

```ts
function stopSlide(completeTap = false) {
  const dir = slide.dir;
  const remaining = completeTap && dir !== 0
    ? Math.max(0, readerLineHeight() - slide.distance)
    : 0;
  slide.dir = 0;
  slide.distance = 0;
  cancelAnimationFrame(slide.raf);
  if (remaining > 0) {
    window.scrollBy({ top: dir * remaining, behavior: 'instant' });
  }
}
```

Only the keyboard `keyup` handler calls `stopSlide(true)`. Wheel, touch-start,
blur, effect cleanup, and direction cancellation continue calling
`stopSlide()` so those paths never manufacture a tap nudge.

Make scroll-derived progress direct and compositor-friendly:

```css
.progress-fill {
  width: 100%;
  height: 100%;
  transform-origin: left center;
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

.ring-fill {
  /* keep the existing declarations; remove the transition entirely */
}
```

```tsx
<div
  class={`progress-fill ${p?.read ? 'read' : ''} ${frontier ? 'frontier' : ''}`}
  style={{ transform: `scaleX(${fill / 100})` }}
/>
```

There is deliberately no transition on either progress surface. They must stop
on the same frame as the reader. No easing or duration token is introduced.

## Repo conventions to follow

- The reader already uses `behavior: 'instant'` for restoration and reset in
  `web/src/app.tsx:431` and `web/src/app.tsx:463`; keyboard jumps follow that
  convention.
- `j`/`k` remains a requestAnimationFrame-based, constant 170 px/s direct
  manipulation. Do not replace it with a tween, spring, dependency, or CSS
  smooth scrolling.
- `prefers-reduced-motion` handling remains on pointer-triggered TOC and
  in-document anchor scrolling through the existing `readerScrollToElement()`.
- The progress tracker must continue re-measuring section bounds on every
  evaluation. That is a documented product decision and is outside this plan.
- Progress remains scroll-driven and monotonic. Do not change
  `web/src/progress.ts`.

## Steps

1. In `web/src/app.tsx`, remove the unconditional `window.scrollTo()` from the
   wheel/touch-start cancellation listener.
2. In `web/src/app.tsx`, replace the smooth absolute-scroll helper with
   `readerJumpTo()` and add `readerJumpToElement()`. Route only `[`/`]` and
   `g`/`G` through these instant helpers. Leave pointer TOC and article-anchor
   handlers on `readerScrollToElement()`.
3. In `web/src/app.tsx`, add `distance` to the slide state, reset and accumulate
   it during a slide, add `readerLineHeight()`, and make `stopSlide()` complete
   a partial line only when passed `true` by the `keyup` handler.
4. In `web/src/app.tsx`, render `.progress-fill` with
   `transform: scaleX(fill / 100)` instead of a percentage width.
5. In `web/src/styles.css`, give `.progress-fill` full width and a left-center
   transform origin; delete its width transition. Delete the ring's
   `stroke-dashoffset` transition.
6. Update the scrolling description in `AGENTS.md` so it states that `[`/`]`
   and `g`/`G` are instant keyboard jumps, pointer TOC/anchor clicks remain
   browser-smooth, natural input does not issue a competing scroll, short
   `j`/`k` taps complete one line, and progress surfaces track scroll directly.

## Boundaries

- Do NOT modify `web/src/progress.ts`, progress semantics, persistence, WPM
  sampling, reading-line math, or section re-measurement.
- Do NOT change pointer TOC clicks or article anchor clicks from their existing
  browser-smooth/reduced-motion behavior.
- Do NOT add a destination-heading flash; it was not among selected findings
  1–4.
- Do NOT change the settled `SLIDE_PX_PER_S = 170` value.
- Do NOT add dependencies, motion libraries, easing tokens, or duration tokens.
- Do NOT touch unrelated transitions or celebrations in `styles.css`.
- If any excerpt no longer matches commit `2734042`, STOP and report the drift
  instead of improvising.

## Verification

- **Mechanical**:
  - Run `npm run build`; expect Vite and server TypeScript compilation to pass.
  - Run `npx tsc -p web/tsconfig.json --noEmit`; expect no diagnostics.
  - Run `git diff --check`; expect no whitespace errors.
- **Feel check**: run `markread` on the repository in a real browser and confirm:
  - Trackpad/wheel scrolling begins and stops under the reader's hand without a
    counter-jump or extra settling frame.
  - Tap `j` and `k` quickly: each press lands exactly one current body line away.
  - Hold `j` or `k`: motion remains a constant, followable 170 px/s and stops on
    keyup; wheel/touch interruption does not add a line nudge.
  - Press `[`/`]` and `g`/`G`: the target is reached in the same frame with no
    animated tail.
  - Click a TOC item: pointer navigation retains its existing browser-smooth
    motion and can still be interrupted by wheel/touch.
  - While scrolling, the segmented progress bar and ring track the viewport
    directly and stop changing when input stops.
  - In DevTools' Animations panel at 10% playback, neither keyboard navigation
    nor scroll-derived progress creates an animation entry.
  - Toggle `prefers-reduced-motion`: TOC and article-anchor movement becomes
    instant; direct keyboard and progress behavior is unchanged.
- **Done when**: all mechanical checks pass and natural input, keyboard jumps,
  `j`/`k` tap/hold behavior, pointer navigation, and both progress surfaces
  satisfy every observable check above.
