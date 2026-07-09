# AutoPoster — Scheduling Throughput (Future Product Direction)

**Status:** documented direction only — NOT implemented, NOT scheduled. 2026-07-09.
**Product intent:** faster scheduling throughput for a human operator. This is explicitly **not** spam automation.

## Current friction

Scheduling one video at a time is slow: the upload/schedule flow can refresh or delay the page, losing form state and forcing re-entry between videos.

## Direction (priority order)

**P1 — single-video flow speed (preferred first step)**
- Preserve page/form state across upload + schedule
- Avoid full-page refresh after submit
- Inline success confirmation
- Upload progress indicator

**P2 — Fast Schedule Queue**
Multi-row queue, each row: media · caption · account/channel · date · time · status.
Operator fills several rows, schedules them in one review pass ("Schedule All" as a possible later addition).

**P3 — daily recurring campaign**
Recurring queue with a **safe default of 1 post/day** until an end date.

## Hard boundaries

- No high-frequency posting as a default (no "every 2 hours" preset).
- High-frequency posting is advanced/guarded/out-of-scope.
- Live publishing remains human-approval gated regardless of throughput features (see `CHANTER_SECURITY_GATES.md` at workspace root — exact approval phrase required for any controlled live test).
