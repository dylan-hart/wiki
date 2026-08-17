# Variances

Genuine, justified deviations from spec — not a changelog. An entry is removed once resolved rather
than left as historical prose.

## 2026-08-17 — Epic 13 (Migration & Upgrade Path from 2.5.x) will not carry forward 2.5.x API tokens or Slack/Discord notification config

The epic roadmap research for Feature 399 left open whether the 2.5.x→3.x migration importer needs
to translate 2.5.x's GraphQL "API Access" tokens, or any Slack/Discord comment-notification
configuration. Resolution: **both are explicitly out of scope for Epic 13's importer.**

**API tokens.** 2.5.x API tokens (`docs.requarks.io/dev/api`) are GraphQL-scoped JWTs bound to a
single user and a fixed list of GraphQL permission scopes — they authorize a specific account against
a specific query surface. This fork's `apiKeys` table (`backend/db/schema.ts`) is a different shape
entirely: keys are bound to a list of **groups** (`groups` jsonb column), not a user, and authorize
REST endpoints under the group's ordinary permission set rather than a GraphQL scope list (see
`backend/models/apiKeys.ts`, `backend/api/apiKeys.ts`). There is no GraphQL server left in this fork
to scope a token against in the first place (see CLAUDE.md, "GraphQL is being removed"). Because the
two token models have no field-for-field mapping — user-bound vs. group-bound, GraphQL scopes vs.
REST/group permissions, and a different signing scheme (this fork's keys are JWTs signed by an
instance-local keypair generated at migration time, per `SigningCertificates` in
`models/apiKeys.ts`) — migration tooling should not attempt to translate old tokens. Instead, Epic
13's importer should surface a post-migration step telling administrators that existing API tokens do
not carry forward and that they must issue new API keys against the migrated groups.

**Slack/Discord notifications.** 2.5.x never shipped a native Slack/Discord notification feature
(confirmed by searching `docs.requarks.io` and the `requarks/wiki` GitHub repo/issues for the term).
Administrators who wanted this ran third-party scripts that polled the GraphQL API using a
manually-issued API token — e.g. the community `@f17/wikijs-notify` package — entirely outside
2.5.x's own configuration surface. There is therefore no first-party 2.5.x setting for a migration
tool to read or port. This fork's native webhook system (`backend/models/hooks.ts`,
`backend/api/hooks.ts`) is a superset of that DIY capability (first-party event subscriptions,
including `comment:new`/`comment:edit`/`comment:delete`, POSTed to an arbitrary URL — Slack and
Discord both accept incoming webhooks directly), but since nothing upstream held this as data, Epic
13's importer has nothing to import for it. Administrators who relied on a community polling script
should configure a native webhook against their Slack/Discord incoming-webhook URL post-migration
instead.

Recording this here so a future spec pass on Epic 13 does not re-open or re-derive either question.
