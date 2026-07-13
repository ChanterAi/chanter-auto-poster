# AutoPoster Daily Recurring Campaigns

**Status:** Implemented and test-validated
**Version:** P1
**Scope:** Repeat the selected video set every day, at the same local posting time, across one or more connected channels.

## User Contract

The intake form now exposes:

- `Repeat: One time | Every day`
- Start date
- End date
- Start time
- Minutes between channels
- `Approve the full daily series now`
- A live projected release-job count before submission

The date range is inclusive. Additional one-off posts remain allowed before, between, and after recurring releases. A recurring campaign does not reserve an exclusive daily slot.

The browser preview is advisory. The server recomputes the entire plan and remains authoritative.

## Scheduling Contract

- Frequency: daily only.
- Inclusive start and end dates.
- The first release must be in the future.
- The same local wall-clock posting time is preserved each day.
- The browser's IANA timezone is submitted and persisted, so schedules remain locally stable across daylight-saving offset changes.
- A nonexistent local time during a daylight-saving transition fails closed instead of shifting silently.
- Existing per-channel offset remains active on every occurrence.
- Maximum date range: 365 calendar days.
- Maximum generated release jobs per request: 200.
- The 200-job calculation includes **videos × days × channels**.
- Workspace plan limits, usage-cycle limits, and active-queue limits can impose a lower effective cap.
- Reversed, malformed, past-start, invalid-timezone, or oversized requests fail before media or queue mutation.

## Approval Contract

`Approve the full daily series now` is checked by default for the authenticated admin flow.

When selected, the form submission records one human approval identity and every generated release receives the same approval evidence at creation. When cleared, every generated job remains a scheduled draft and cannot publish until approved through the existing Release Queue gate.

Runtime and MCP scheduling do not gain a bypass from this feature.

## Storage and Evidence

Every generated job stores:

- `seriesId`
- `seriesFrequency`
- `seriesStartDate`
- `seriesEndDate`
- `seriesOccurrenceIndex`
- `seriesOccurrenceCount`
- `seriesOccurrenceDate`
- `seriesSourceCount`
- `seriesTimezone`
- `campaignStartAt`
- per-channel order and offset

The media asset is uploaded once per target channel/source and shared by that source's daily occurrences. Deleting one occurrence does not destroy a shared Cloudinary asset while another queue item still references it.

Usage is authorized and reserved against the complete generated job count before queue creation.

## Current Boundary

This pass creates and evidences recurring series. Dedicated series-level controls are intentionally not included yet:

- Pause series
- Resume series
- Edit this and following
- Cancel remaining occurrences

The persisted series metadata is the foundation for those operations.
