# Decision: keep the webhook `acceptUntrusted` → `rejectUnauthorized: false` opt-in as-is

Status: **Keep, documented.** OpenProject #3371, Epic #3366 ("Supply-chain, container, and
documentation hardening from the 2026-09-17 scanner sweep"), Feature #3367.

## Context

`backend/models/hooks.ts`'s `postJson()` (the function every webhook delivery, plus
`POST /_api/hooks/test`, goes through) sets Node's `https.request()` option
`rejectUnauthorized: false` when both of the following hold:

- the target URL's protocol is `https:`, and
- the webhook's `acceptUntrusted` flag is `true`.

`acceptUntrusted` is a real, persisted per-webhook column (`backend/db/schema.ts`:
`acceptUntrusted boolean().notNull().default(false)`), set explicitly by an admin per webhook
through the webhook editor (`admin.webhooks.acceptUntrusted` / `...Hint` locale strings), defaulting
to off, and threaded through `api/hooks.ts`'s create/update/test routes into `postJson()`'s
`acceptUntrusted` parameter. There is no global or default-on variant of this behavior.

`docs/audits/security-reviews/2026-09-17-scanner-sweep-trivy-gitleaks-semgrep.md` flagged this via
Semgrep's `bypass-tls-verification` rule, which matches the literal `rejectUnauthorized: false`
regardless of any surrounding gate.

## Decision

Keep the behavior exactly as-is: it is a deliberate, narrowly-scoped admin opt-in for webhook
targets on self-signed or internal certificates (common for on-prem/internal receivers), not a
blanket TLS bypass — it cannot affect any other outbound connection this codebase makes (mail, LDAP,
Elasticsearch, and the Postgres connection each carry their own independent, default-verifying TLS
options; see `backend/models/mail.ts`, `backend/modules/authentication/ldap/authentication.ts`,
`backend/modules/search/elasticsearch/search.ts`, `backend/core/db.ts`).

No code change was warranted. What was missing was a comment at the flagged line itself, so a future
scanner run or reviewer grepping for `rejectUnauthorized: false` finds the rationale immediately
instead of re-opening the question each audit cycle — added directly above the `rejectUnauthorized`
spread in `backend/models/hooks.ts`'s `postJson()`.

## Why not remove or further restrict it

- Self-signed/internal-CA HTTPS endpoints are a legitimate, common webhook receiver shape
  (internal automation, home-lab/self-hosted receivers, staging environments) and there is no other
  way for an admin to keep TLS confidentiality on the wire for such an endpoint while still
  accepting its certificate — falling back to plain `http:` for the same host would be strictly
  worse (no confidentiality at all) and isn't offered as an equivalent workaround.
- It is opt-in and off by default, requires an authenticated admin action to enable, is scoped to
  exactly one webhook at a time, and the UI hint already warns against enabling it
  (`admin.webhooks.acceptUntrustedHint`).
