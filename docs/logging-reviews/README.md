# Logging reviews

Reviews of what this codebase writes to its logs, and what it should. Each review is dated; the
newest is authoritative where they disagree.

| Date | Document | What it is |
| --- | --- | --- |
| 2026-09-05 | [2026-09-05-audit.md](2026-09-05-audit.md) | Current state: architecture, inventory, real output samples, 41 numbered findings (readability R*, verbosity V*, missing N*, remove X*, correctness C*), and a side-by-side with upstream Wiki.js 3.0 |
| 2026-09-05 | [2026-09-05-recommendations.md](2026-09-05-recommendations.md) | The target design — line format, scope vocabulary, level policy, logger API, new logging, the removal catalogue, enforcement, a six-phase plan and acceptance criteria |
| 2026-09-05 | [2026-09-05-call-site-inventory.md](2026-09-05-call-site-inventory.md) | Every `WIKI.logger` call site by file, with a verdict for the files that carry most of the volume |

## Status: what has shipped

The 2026-09-05 recommendations are being implemented under **Epic #2643**, in the six phases
§9 lays out. Landed so far:

| Phase | What landed | Where to read it now |
| --- | --- | --- |
| 1 | The scoped, structured logger (`(scope, message, fields?)`, `WIKI.logger.scope()`, `error`/`ms` rendering, `logFormat: text` \| `json` validated at boot, `BACKLOG_SIZE` 100 → 500) and the closed 27-name scope vocabulary | `backend/core/logger.ts`, `backend/core/logScopes.ts` |
| 2 | The call-site sweep onto that shape and the level policy, and the conventions written down | `CLAUDE.md` § Logging (the rule for new code), `docs/operations.md` § Logs (the operator's view), `config.sample.yml` |
| 4 | Structured frames on the admin log websocket instead of pre-rendered ANSI | `backend/core/logger.ts`'s `LogFrame`, `backend/controllers/terminal.ts` |

Still open at the time of writing: the Fastify access line through `WIKI.logger` (§4.1), per-scope
thresholds and the two admin flags as scope overrides (§4.3), the new logging of §5, and the lint
plus structural-test enforcement of §8. **`CLAUDE.md` § Logging is authoritative for writing a new
log line**; this directory is the reasoning behind it, not the reference.

## Summary (2026-09-05)

The logger core is small, correct and in three respects better than upstream's (context objects,
`Error` serialisation, process guards). What comes out of it is not: 88% of an idle day's lines are
scheduler heartbeat at `info`, Fastify's pino writes raw JSON between the coloured text lines in
the default mode, unhandled 500s are `warn`, an invalid `logLevel` silently logs everything, and
the vocabulary — `=== Wiki.js 3.0.0 ===`, `Initializing...`, `[ OK ]`, `[ COMPLETED ]` — is
upstream's verbatim.

The recommendation is one line shape (`timestamp level scope message key=value…`), a closed scope
vocabulary, a level policy where `info` means a state change and heartbeats are `debug`, one
producer for everything including the access log, and a mechanical sweep of the 481 call sites
enforced afterwards by a structural test. Done in full it makes the log both quieter and
unmistakably not Wiki.js's; done by half it is worse than either, which is why the plan sequences
the core change before the sweep and forbids stopping between them.

## Conventions for a new review

- File name `YYYY-MM-DD-<subject>.md`; add a row above.
- Quote real output, not reconstructed output. A running container's `docker logs` or a local
  `node backend` capture; say which commit produced it.
- Number findings so a work package can cite one.
