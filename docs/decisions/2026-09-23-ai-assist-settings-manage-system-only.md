# Writing assistant: the on/off switch and the daily cap belong to whoever pays for the API key

- **Status:** Accepted
- **Date:** 2026-09-23
- **Work package:** OpenProject #3764 (Feature #3749, Epic #329)

## Context

The Markdown editor's writing assistant spends a metered API key. Only `manage:system` can configure
that key, on the AI admin page (`PUT /_api/sites/:siteId/ai`). The assistant's two settings, the
switch and the per-user daily cap, used to be stored under the site's `features` key. The General
admin page edited them.

`PUT /_api/sites/:siteId` checks permissions per body key. `api/sites.ts`'s `SITE_FIELD_PERMISSIONS`
hands `features` as a whole to the `site:general` delegation permission. That let a site delegate
without `manage:system` do two things with a paid resource they were never meant to control:

- turn the assistant on, and
- raise every user's daily cap to `AI_ASSIST_MAX_DAILY_CAP` (100000).

## Decision

**Both settings live beside the provider config, as `config.ai.assist` and
`config.ai.assistDailyCap`, and only `manage:system` can write them.**

- The AI page's existing save, `PUT /_api/sites/:siteId/ai`, accepts both as optional fields. It
  saves them even when `provider` is empty, so the switch can be set before a provider is chosen.
- The AI page reads them from a new `GET /_api/sites/:siteId/ai`, also `manage:system`.
- The `Site` schema's `features` object sets `additionalProperties: false`. Fastify's default
  `removeAdditional` then strips `features.aiAssist` and `features.aiAssistDailyCap` from a
  `PUT /_api/sites/:siteId` body before the handler runs. A `site:general` caller sending them
  changes nothing.
- A top-level `ai` key on that route has no `SITE_FIELD_PERMISSIONS` entry. A delegate sending one
  is refused with 403. A `manage:sites` caller's `ai` key is dropped, because the route copies only
  `SITE_CONFIG_KEYS`.
- `config.ai` is never part of the public site payload (`buildSitePayload`), so neither setting
  reaches a reader's browser any more. The editor learns whether the assistant is available from
  `GET /_api/sites/:siteId/ai/status`.
- No migration and no fallback to the old location. There are no production instances, so the
  flat-schema rule applies: the seeded defaults in `models/sites.ts` changed shape, and nothing reads
  `features.aiAssist` any more.

## Why

- **Spend control stays with whoever controls the key.** `manage:system` already owns the provider,
  its API key and the choice to turn AI off. The switch and the cap decide how much of that key gets
  spent, so they belong to the same permission.
- **No new concept is needed.** The route that already guards the key now guards the settings too.
  No new permission, delegation rule or per-key exception in `SITE_FIELD_PERMISSIONS` was added.
- **Stripping is enforced by the schema, not by a handler rule.** `additionalProperties: false` on
  `features` covers every key the schema does not declare. Removing a key from the schema is enough
  to stop the route accepting it, and no second list has to be kept in step.

## Alternatives rejected

- **A per-site cap ceiling set by `manage:system`, leaving delegates free below it.** Rejected at
  triage. It adds a setting and a clamp, and a delegate could still switch the assistant on and spend
  up to the ceiling.
- **Refusing the whole `PUT` with 400 when the moved keys appear.** Rejected. A stale client sending
  its whole `features` object would then fail to save unrelated settings. Stripping gives the same
  guarantee without that failure.
- **Making `features` as a whole `manage:system`-only.** Rejected. The other feature switches
  (comments, browse, profile and so on) are ordinary site settings, and handing them to a site
  delegate is what `site:general` exists for.
