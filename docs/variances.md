# Variances

Genuine, justified deviations from spec — not a changelog. An entry is removed once resolved rather
than left as historical prose.

## 2026-08-17 — 3.0 will not carry forward 2.5.x's anonymized Telemetry toggle

Feature 387 (System Utilities & Maintenance Actions) asked to resolve the gap left by two orphaned
locale keys (`admin.utilities.telemetryTitle` / `telemetrySubtitle`) referencing a Utilities >
Telemetry panel that was never built in 3.0: 2.5.x's opt-in toggle (`docs.requarks.io`) reported
anonymized version/OS/DB-type data plus a resettable random client id to a collection endpoint
operated by the upstream `requarks/wiki` maintainers. Resolution: **explicitly declined, not
carried forward.**

The upstream collection endpoint is not this fork's to send data to — it is operated by the
`requarks/wiki` project, which this fork has diverged from (AGPL-3.0, no upgrade path from 2.x, per
CLAUDE.md), and this fork's maintainers run no telemetry-collection service of their own. A real
implementation would need a genuine destination; the alternative the task description offered —
building the settings, the resettable client id, the route pair, and the UI, but pointing the
outbound call at a stub — adds a config surface (`telemetry.isEnabled`, `telemetry.clientId` in
`base.yml`), a `GET`/`PUT /_api/system/telemetry` route pair, and a "reset client id" action for a
toggle that would visibly do nothing: no data collection service is reachable, so `isEnabled: true`
sends data nowhere, and the reset button spins a fresh id with no receiver to observe it. That is
strictly worse than not having the panel — a control that appears to work but silently doesn't is
the kind of half-referenced state this task exists to eliminate, not a lesser version of it.

The existing `GET`/`PUT /_api/system/metrics` route pair (`backend/api/system.ts`) is the precedent
for how this fork already handles an analogous "the collector isn't implemented yet" situation: it
stores the toggle state and says so plainly in the route's OpenAPI description ("the endpoint itself
is not implemented yet"). Telemetry has no equivalent honest middle ground, because the missing half
is not an endpoint this fork could implement later — it is a third party's collection service this
fork was never going to send data to. Should this fork later stand up its own anonymized
usage-reporting service, that would be new product work with its own spec, not a resurrection of
2.5.x's toggle.

The two orphaned locale keys were deleted (`backend/locales/en.json`) rather than left pointing at a
panel that doesn't exist.

Recording this here so a future spec pass on Feature 387 does not re-open or re-derive the question.
