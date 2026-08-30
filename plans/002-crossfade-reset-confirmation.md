# 002 — Crossfade the reset confirmation

- **Status**: DONE
- **Commit**: e257d34
- **Severity**: LOW
- **Category**: Missed opportunities, interruptibility, accessibility
- **Estimated scope**: 2 source files, about 36 changed lines

## Problem

The reading-progress reset is deliberately a two-step destructive action. The
first activation arms confirmation, the second performs the reset, and an
unconfirmed state disarms itself after 2.5 seconds:

```ts
// web/src/app.tsx:488 — current
// The confirm state reverts on its own if the second click never comes.
useEffect(() => {
  if (!confirmReset) return;
  const timer = setTimeout(() => setConfirmReset(false), 2500);
  return () => clearTimeout(timer);
}, [confirmReset]);
```

The visible control currently replaces the reset icon with the confirmation
question in one render:

```tsx
// web/src/app.tsx:1035 — current
<button
  class={`doc-reset ${confirmReset ? 'confirm' : ''}`}
  title="Reset reading progress"
  onClick={() => (confirmReset ? resetProgress() : setConfirmReset(true))}
>
  {confirmReset ? 'reset progress?' : '↺'}
</button>
```

Only the color is transitioned:

```css
/* web/src/styles.css:805 — current */
.doc-reset {
  font: inherit;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--ink-faint);
  transition: color 150ms ease;
}
```

The icon-to-question swap is therefore abrupt at the exact moment the reader
needs to understand that the control has become armed. The reverse swap after
the timeout is equally abrupt. This is an occasional, safety-relevant state
change, so a brief transition improves legibility without slowing the reset.

## Target

Keep both labels mounted in the same grid cell. Crossfade them with an
interruptible CSS transition so a state reversal retargets from the current
visual state instead of restarting keyframes. Reserve the confirmation label's
footprint in both states; do not animate `width`, `margin`, or any other layout
property.

Render the control as follows:

```tsx
// web/src/app.tsx — target
<button
  class={`doc-reset ${confirmReset ? 'confirm' : ''}`}
  title={confirmReset ? 'Confirm reset reading progress' : 'Reset reading progress'}
  aria-label={confirmReset ? 'Confirm reset reading progress' : 'Reset reading progress'}
  onClick={() => (confirmReset ? resetProgress() : setConfirmReset(true))}
>
  <span class="doc-reset-label doc-reset-icon" aria-hidden="true">↺</span>
  <span class="doc-reset-label doc-reset-confirm" aria-hidden="true">reset progress?</span>
</button>
```

Add the strong ease-out curve from the animation audit vocabulary to the
existing `:root` design tokens:

```css
/* web/src/styles.css — target, inside :root */
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
```

Replace the reset-control styling with this exact motion model:

```css
/* web/src/styles.css — target */
.doc-reset {
  display: inline-grid;
  align-items: baseline;
  justify-items: end;
  font: inherit;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: var(--ink-faint);
  transition: color 150ms ease;
}

.doc-reset-label {
  grid-area: 1 / 1;
  white-space: nowrap;
  transform-origin: right center;
  transition:
    opacity 150ms var(--ease-out),
    transform 150ms var(--ease-out);
}

.doc-reset-icon {
  opacity: 1;
  transform: scale(1);
}

.doc-reset-confirm {
  opacity: 0;
  transform: scale(0.97);
  pointer-events: none;
}

.doc-reset.confirm .doc-reset-icon {
  opacity: 0;
  transform: scale(0.97);
}

.doc-reset.confirm .doc-reset-confirm {
  opacity: 1;
  transform: scale(1);
}
```

The two labels share a single grid cell, so they occupy one stable footprint
and never reflow each other during the transition. The `150ms` duration is
inside the 100–160ms button-feedback budget. `scale(0.97)` keeps the change
physical without making either state appear from nothing. Only `transform` and
`opacity` move.

Reduced motion keeps the comprehension-aiding crossfade but removes scale:

```css
/* web/src/styles.css — target */
@media (prefers-reduced-motion: reduce) {
  .doc-reset-label {
    transform: none;
    transition: opacity 150ms var(--ease-out);
  }

  .doc-reset-icon,
  .doc-reset-confirm,
  .doc-reset.confirm .doc-reset-icon,
  .doc-reset.confirm .doc-reset-confirm {
    transform: none;
  }
}
```

Do not add blur. At this size, blur would soften the mono label and add paint
work without improving the state story.

The stable two-label footprint increases the reset control's intrinsic width.
Allow the existing flex reading pane to shrink at the narrow desktop/mobile
boundary so this intrinsic width cannot force page-level horizontal overflow:

```css
/* web/src/styles.css — target */
.reading-pane {
  flex: 1;
  min-width: 0;
  /* keep every existing declaration */
}
```

This is static flex containment, not an animation. It reinforces the existing
rule that wide document content scrolls inside its own container and the page
never scrolls horizontally.

## Repo conventions to follow

- Shared visual values already live in `:root` in `web/src/styles.css:7-39`.
  Add `--ease-out` there; do not create a second token file for one curve.
- The control already uses a `150ms` color transition in
  `web/src/styles.css:805-818`. Keep that color behavior and duration.
- The existing `help-in` motion at `web/src/styles.css:1266-1269` establishes
  the repo's use of small `scale(0.97)` plus opacity. This plan uses the same
  restrained distance but implements the reversible reset state with CSS
  transitions, not keyframes.
- `confirmReset` remains the single source of truth. Both pointer activation
  and `Shift+R` already use it in `web/src/app.tsx:778-782`; do not add a second
  visual-state hook or timer.
- The product's progress and navigation surfaces are intentionally direct.
  This plan applies only to the rare reset-arming state and must not spread
  animation to keyboard navigation, scroll-derived progress, or reading text.

## Steps

1. In `web/src/styles.css`, add
   `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` to the existing `:root` block.
2. In `web/src/app.tsx`, replace the conditional reset text node with the two
   always-mounted `.doc-reset-label` spans shown in the target. Give the button
   the exact dynamic `title` and `aria-label`; mark both visual spans
   `aria-hidden="true"` so the accessible name is not duplicated.
3. In `web/src/styles.css`, make `.doc-reset` an inline grid and add the label,
   idle-state, and `.confirm`-state rules exactly as specified. Preserve the
   current color transition and the existing hover/confirm accent rule.
4. In `web/src/styles.css`, add the scoped reduced-motion block shown above.
   Keep opacity feedback and remove only the scale component.
5. In `web/src/styles.css`, add `min-width: 0` to `.reading-pane` so the stable
   reset-label footprint cannot enlarge the page near the 760px breakpoint.
6. Do not update `AGENTS.md` or `REQUIREMENTS.md`; this is a local presentation
   refinement and does not alter reset semantics or a product-level rule.

## Boundaries

- Do NOT change the two-step reset behavior, the `2500`ms confirmation timeout,
  the DELETE request, progress clearing, scroll-to-top behavior, or any state
  persistence code.
- Do NOT delay `setConfirmReset(true)` or `resetProgress()` to wait for motion.
  Input and destructive-action semantics remain immediate.
- Do NOT add animation to width, margin, padding, position, blur, or layout.
  Preserve the existing color transition unchanged; the new crossfade animates
  only `transform` and `opacity`.
- Do NOT add responsive hiding or truncation for the reset labels. The only
  responsive containment change is static `min-width: 0` on `.reading-pane`.
- Do NOT use keyframes, Web Animations API, View Transitions, JavaScript timers,
  or an animation library for this crossfade.
- Do NOT add dependencies or modify any other control, panel, progress cue,
  celebration, flash card, navigation path, or reduced-motion behavior.
- Do NOT add shadows, bounce, overshoot, or decorative symbols.
- If the excerpts no longer match commit `e257d34`, STOP and report the drift
  instead of improvising.

## Verification

- **Mechanical**:
  - Run `npm run build`; expect Vite and server TypeScript compilation to pass.
  - Run `npx tsc -p web/tsconfig.json --noEmit`; expect no diagnostics.
  - Run `git diff --check`; expect no whitespace errors.
  - Inspect the rendered reset button and confirm its accessible name is
    `Reset reading progress` when idle and `Confirm reset reading progress`
    when armed. Confirm only one accessible name is exposed despite both
    visual spans being mounted.
- **Feel check**: run `markread` on the repository in a real browser and:
  - Click `↺` once. The icon must begin fading immediately while
    `reset progress?` fades and scales in from `0.97`; there is no delayed
    response and no overshoot.
  - Wait 2.5 seconds without confirming. The transition reverses cleanly to
    `↺`; neither label jumps, restarts from zero, or changes horizontal
    position.
  - Arm reset and click the confirmation. Progress resets immediately; the
    animation must never delay the DELETE request or scroll-to-top behavior.
  - Repeat with `Shift+R`. It uses the same visual state and timing as pointer
    activation, while the shortcut itself remains immediate.
  - Resize just above and below the 1180px and 760px breakpoints and test long
    document paths, all four font choices, size 24px, and measure 55ch. The
    stable label footprint must not overlap the odometer, minutes-left label,
    document path, or viewport edge.
  - In DevTools' Animations panel at 10% playback, confirm both labels stay in
    the same grid cell: one moves only from scale `1` to `0.97` while fading
    out, the other from `0.97` to `1` while fading in. There must be no width or
    positional interpolation.
  - Emulate `prefers-reduced-motion: reduce` in DevTools. Both labels still
    crossfade for `150ms`, but neither label scales or moves.
- **Done when**: mechanical checks pass; pointer and `Shift+R` preserve the
  existing two-step semantics; idle, armed, timeout, and confirmed states use
  the exact accessible names; the crossfade is interruptible and limited to
  `150ms`; reduced motion removes scale but keeps opacity; and the meta bar has
  no overlap or animated reflow at the tested sizes.
