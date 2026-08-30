# Animation plans

| Plan | Title | Severity | Status | Dependencies |
| --- | --- | --- | --- | --- |
| [001](./001-make-scrolling-direct.md) | Make scrolling direct and predictable | HIGH | DONE | None |
| [002](./002-crossfade-reset-confirmation.md) | Crossfade the reset confirmation | LOW | DONE | None |

## Recommended execution order

1. Plan 001 is complete; its direct-scrolling behavior is the baseline that
   later motion work must preserve.
2. Plan 002 is complete. Its reset-control transition remains independent of
   the direct-scrolling input path.
