# Logging reviews

Reviews of what this codebase writes to its logs, and what it should. Each review is dated; the
newest is authoritative where they disagree.

| Date | Document | What it is |
| --- | --- | --- |
| 2026-09-05 | [2026-09-05-audit.md](2026-09-05-audit.md) | Current state: architecture, inventory, real output samples, 41 numbered findings (readability R*, verbosity V*, missing N*, remove X*, correctness C*), and a side-by-side with upstream Wiki.js 3.0 |
| 2026-09-05 | [2026-09-05-recommendations.md](2026-09-05-recommendations.md) | The target design — line format, scope vocabulary, level policy, logger API, new logging, the removal catalogue, enforcement, a six-phase plan and acceptance criteria |
| 2026-09-05 | [2026-09-05-call-site-inventory.md](2026-09-05-call-site-inventory.md) | Every `WIKI.logger` call site by file, with a verdict for the files that carry most of the volume |

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
