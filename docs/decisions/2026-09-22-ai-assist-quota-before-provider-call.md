# Writing assistant: the daily allowance is spent before the provider call and never refunded

- **Status:** Accepted
- **Date:** 2026-09-22
- **Work package:** OpenProject #3753 (Feature #3749, Epic #329)

## Context

The Markdown editor's writing assistant (rewrite, summarize, expand, generate from a prompt) sends
text to an AI provider using the administrator's own metered API key. Each site has two settings for
it:

- `ai.assist` turns it on, and is off by default.
- `ai.assistDailyCap` (default 50) limits how many actions each user may run in a 24-hour
  window.

The counter is the existing database-backed rate limiter (`models/rateLimits.ts`), with the key
`ai-assist:<siteId>:<userId>`. That keeps it consistent across instances behind a load balancer, the
same property the authentication limiter relies on.

`POST /_api/sites/:siteId/ai/generate` (`api/aiAssist.ts`) checks the following in order, and only
the fifth step writes to the counter:

1. A guest is refused with 401.
2. `ai.assist` being off gives 403. This is checked before `write:pages`, the same shape as
   `features.pageScripts`.
3. No `write:pages` on the page gives 403.
4. The allowance being used up gives 429 with `Retry-After`. This check reads the counter through
   `RateLimits.peek()` without writing to it.
5. No provider being configured gives 503.
6. One unit of the allowance is consumed.
7. The provider is called. A `null` result gives 503.

`GET /_api/sites/:siteId/ai/status` runs steps 1 to 5 only, so the editor can hide or disable the
actions without using any of the allowance.

## Decision

**A unit is consumed immediately before the provider call and is not refunded if the call fails,
times out or returns nothing.**

## Why

- **The cost happens whether the call succeeds or not.** A provider request that times out or fails
  after sending may still be billed. The allowance exists to bound spending on the administrator's
  key, so a failed call still counts.
- **Refunding would reopen a race.** Counting after the call, or refunding on failure, gives a
  client a way round the limit. It could open many requests at once, each seeing an allowance that
  none of them had spent yet. Spending up front means the atomic upsert in `consume()` does the
  counting, so concurrent requests cannot exceed the cap between them.
- **The refusals that cost nothing come first.** A guest, a disabled site, a missing permission, a
  used-up allowance and an unconfigured provider are all refused before any quota is used. A
  misconfigured site therefore never uses up a user's day.

## Consequences

- If a provider is down, each attempt still uses a unit. Someone retrying in a tight loop against a
  failing provider can exhaust their day. This is accepted: the cap protects the budget, and the
  provider's own failure is reported as 503, not 429.
- The window is fixed: it starts with the user's first action and lasts 24 hours. It is not a
  calendar day.
- The attempt that goes over the cap is banned only until the current window ends. This uses
  `peek()`'s `resetsIn`, so going over never pushes the reset later than it would otherwise have
  been.
- An administrator who lowers the cap mid-window applies to that window at once, because `peek()`
  compares the stored count against the current cap.

## Alternatives rejected

- **Count after the call, and only on success.** Rejected because of the race described above, and
  because it does not bound cost when a failed call is still billed.
- **Refund on a `null` result.** Rejected for the same reasons. The route cannot tell a call the
  provider billed from one it did not.
- **A per-site cap, not a per-user one.** Rejected: one heavy user would lock everyone else out,
  and Feature #3749's confirmed scope asks for a per-user daily cap.
