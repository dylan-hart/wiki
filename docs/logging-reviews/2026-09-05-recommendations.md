# Logging recommendations — the Cardinal log voice (2026-09-05)

Companion to [2026-09-05-audit.md](2026-09-05-audit.md), which numbers the findings (R*, V*, N*,
X*, C*) this document resolves. Nothing here is implemented; every item is scoped so it can be filed
as a work package. Section 9 is the phased plan.

The goal is a log that an operator can tail for a week and still notice a warning — and that reads,
at a glance, as this project's and not as Wiki.js's. Both come from the same three moves: **say
the outcome, not the activity**; **put facts in fields, not prose**; **name the subsystem on
every line**.

## 1. Design principles

1. **One producer, one shape.** Everything that reaches stdout goes through `WIKI.logger`,
   Fastify's pino included. No second format on the stream in either mode (R1, N2).
2. **A line is an outcome.** Past tense, states what happened and what it cost. Nothing is
   announced before it starts unless it can plausibly take more than a couple of seconds, and then
   the announcement is `debug` (R4, X4, X8).
3. **Facts are fields.** Counts, ids, durations, paths and hostnames go in a `key=value` tail, not
   in the sentence. In JSON mode the same keys are the record's fields — one call site, both
   outputs (R7, C1).
4. **Every line has a scope.** A short, fixed vocabulary of subsystem names, rendered as a column in
   text mode and a field in JSON. It replaces the five ad-hoc prefixes and makes per-subsystem
   verbosity possible (R2, V6).
5. **The level is the status.** `info` means it worked, `warn` means it degraded, `error` means it
   didn't. No `[ OK ]`, no `successfully`, no `[ FAILED ]` (R3, R9).
6. **Errors are one record.** Situation, message, and — where the level warrants it — the stack,
   attached to one call, not two (R5, R6, C3).
7. **`info` is for state changes, not heartbeats.** If a scheduled job found nothing to do, it
   says so at `debug` or not at all (V1, X1–X3).
8. **Identifiers, never identities.** User ids, not e-mail addresses; site ids, not hostnames
   where the hostname is a person's (C4, X9).
9. **Lowercase, no terminal punctuation.** A message is a fragment that a `key=value` tail can
   follow; capital letters and full stops fight that. (This is the Go/Rust error-string
   convention and it is the single cheapest visual break from upstream's `Capitalised. [ OK ]`.)

## 2. The line

### 2.1 Text mode

```
<timestamp> <level> <scope>   <message> <key=value …>
```

| Column | Rule |
| --- | --- |
| `timestamp` | ISO-8601 UTC with milliseconds, unchanged. Operators need the date; `docker logs -t` users can ignore it. Dim. |
| `level` | `error` `warn ` `info ` `debug`, padded to 5, coloured (red / yellow / plain / dim). No colon. |
| `scope` | padded to 8, dim. See 2.3. |
| `message` | lowercase fragment, no trailing period, no tags. On `error` and `warn` the message is coloured with the level. |
| tail | zero or more `key=value`, space-separated, dim keys. Strings with spaces are quoted. Durations are humanised (`in 3.7s`, `in 12ms`) and carried as `ms=` in JSON. |
| stack | for `error` always, for `warn` only when `logLevel: debug`: the `Error.stack` on following lines, indented two spaces. |

The instance id leaves the text line. Text mode is a person tailing one process; the id is dead
weight there and stays on every JSON record for aggregators. The admin terminal already receives it
in its handshake frame.

The same boot the audit quotes, rewritten:

```
2026-09-04T19:19:50.524Z info  boot      cardinal 3.0.0 starting  node=v26.7.0 instance=46af6c1ac1 config=/wiki/config.yml
2026-09-04T19:19:51.052Z info  db        connected  postgres=18.6 schema=public migrations=0 in 528ms
2026-09-04T19:19:51.054Z warn  config    no settings in db, seeding defaults
2026-09-04T19:19:51.418Z info  config    seeded default site, groups, users, jobs and icon sets  admin=admin@example.com
2026-09-04T19:19:53.901Z info  http      listening  host=0.0.0.0 port=3000
2026-09-04T19:19:54.210Z info  locale    loaded 56 locales  sideloaded=0
2026-09-04T19:19:54.300Z info  auth      enabled 1 strategy  local
2026-09-04T19:19:54.420Z info  jobs      scheduler started  workers=7 planned=11
2026-09-04T19:19:54.431Z info  boot      ready  sites=1 in 3.9s
```

Nine lines instead of roughly 190. The seeded admin e-mail is the one deliberate exception to
principle 8: on a first run it is the only credential the operator has, and it is the one they set.

The quiet minute:

```
(nothing at info)
2026-09-06T03:50:04.987Z debug jobs      storageSyncTick found nothing due
2026-09-06T03:50:05.003Z debug jobs      replicationTick found nothing due
```

A failed request and a failed job:

```
2026-09-04T19:48:21.344Z error http      GET /_api/pages/abc → 500 in 12ms  req=req-1q user=8f3a site=main
  TypeError: Cannot read properties of undefined (reading 'path')
      at Object.<anonymous> (/wiki/backend/api/pages/read.ts:212:31)
      …
2026-09-05T00:30:00.412Z warn  jobs      updateLocales failed, retrying  attempt=1/3 next=00:35:00 error="fetching locale metadata failed: 404"
2026-09-05T00:45:00.900Z error jobs      updateLocales failed, no attempts left  attempts=3 error="fetching locale metadata failed: 404"
  Error: fetching locale metadata failed: 404
      at …
```

### 2.2 JSON mode

Unchanged in spirit; two keys added and one renamed:

```json
{"timestamp":"2026-09-04T19:19:51.052Z","instance":"46af6c1ac1","level":"info","scope":"db","message":"connected","postgres":"18.6","schema":"public","migrations":0,"ms":528}
{"timestamp":"…","instance":"…","level":"error","scope":"http","message":"GET /_api/pages/abc → 500","reqId":"req-1q","method":"GET","url":"/_api/pages/abc","status":500,"ms":12,"userId":"8f3a","siteId":"main","error":{"name":"TypeError","message":"Cannot read …","stack":"TypeError: …"}}
```

- `scope` is a fixed field.
- An `Error` is serialised as `error: { name, message, stack }` rather than replacing `message`
  with the stack. The stack-as-message trick (#939) was the right fix for the bug it fixed; with a
  proper `error` field the message can stay a sentence.
- `logFormat` values become `text` | `json`. `default` is renamed; per the project rule there is no
  alias to keep.

### 2.3 Scopes

The closed vocabulary. A new scope is a one-line addition to the `as const` array, and the
structural test in 8.3 refuses a string outside it.

| Scope | Owns |
| --- | --- |
| `boot` | `index.ts`, `worker.ts`, the phase guards, `ready` |
| `config` | `core/config.ts`, settings load/seed/save, unknown-key warnings |
| `db` | `core/db.ts` connect, migrations, pool errors, the LISTEN/NOTIFY channel |
| `sql` | the `sqlLog` firehose (own scope so it can be routed) |
| `http` | access log, 5xx, app-shell fallback, the `Reply already sent` class of Fastify warnings |
| `auth` | strategies, login/register/2FA/passkey outcomes, API-key and bearer refusals, `authDebug` |
| `session` | secret rotation, session purge |
| `jobs` | scheduler lifecycle, job outcomes, planning |
| `worker` | thread pool online/offline/error |
| `mail` | every `models/mail.ts` line |
| `storage` | `models/storage.ts` and all seven modules; the module key becomes a field (`target=git`) |
| `search` | `models/search.ts` and all five engines; engine key as a field |
| `render` | `models/rendering.ts`, `renderQueue.ts`, puppeteer |
| `collab` | `core/collab.ts` |
| `cluster` | cross-instance events, peer presence, `maintenance.ts` |
| `locale` | `models/locales.ts`, `update-locales` |
| `icons` | `models/icons.ts`, `api/icons.ts` |
| `blocks` | `models/blocks.ts`, custom block uploads |
| `ext` | `models/extensions.ts` |
| `pages` | page/tree/folder lifecycle, drafts, approvals, watch notifications |
| `assets` | uploads, thumbnails, the file cache, `helpers/images.ts` |
| `nav` | navigation rewrites |
| `hooks` | webhook deliveries and the three notification fan-outs |
| `mcp` | `mcp/` |
| `terminal` | `controllers/terminal.ts` |
| `migrate` | the 2.5.x → 3.0 CLI and verifier |
| `audit` | `models/auditLog.ts`'s own failures (the audit *table* is not the log) |

### 2.4 API

```ts
WIKI.logger.info('db', 'connected', { postgres: '18.6', schema, migrations: 0, ms })
WIKI.logger.error('jobs', 'updateLocales failed, no attempts left', { attempts, error: err })
WIKI.logger.debug('jobs', 'storageSyncTick found nothing due')
```

`(scope, message, fields?)`. `fields.error` may be an `Error`; the formatter renders it (text:
message inline as `error="…"`, stack below when the level warrants; JSON: the `error` object). A
`fields.ms` renders as the humanised duration. Every other key renders as `key=value`.

A scoped child is the ergonomic form for a file that logs a lot from one subsystem:

```ts
const log = WIKI.logger.scope('storage', { target: target.id, module: target.module })
log.warn('daily backup failed', { site: site.id, error: err })
```

`verbose` and `silly` are deleted from the type. Nothing calls them; a caller that did would be a
type error, which is the desired outcome.

## 3. Level policy

| Level | Meaning | Examples |
| --- | --- | --- |
| `error` | A person needs to act. Something is broken and will stay broken. | boot failure; a job out of retries; an unhandled 5xx; an external system unreachable after its retries; a storage target whose sync leaves the working copy mid-rebase; the puppeteer extension failing to launch |
| `warn` | Degraded, self-healing, or a configuration smell. | a job retrying; `no settings in db, seeding defaults`; unknown config key; mail unconfigured while a notification was due; `--no-sandbox` enabled; a rate-limit ban issued; an API key refused; a webhook over its delivery limit; text search dictionary missing |
| `info` | A state change an operator would want in the record. | boot milestones and `ready`; config reload; strategy/storage/search (de)activation; a job that *did* something; page/asset/site/nav lifecycle (one line each); login outcomes (rate-limited, see 5.3); cluster peer join/leave; secret rotation; extension install; render queue drained |
| `debug` | Per-item, per-request, per-tick. | access log; every job start/finish; every locale loaded; every cluster event received; icon fetches; draft persistence; tree operations; the two flag firehoses |

Consequences, applied to the current sites:

- **Unhandled 5xx moves from `warn` to `error`** (V3). An operator alerting on `error` must see a
  crashed request. `api/sites.ts:449,810` drop their private `warn(err)` and let `apiErrorHandler`
  do it once, with context.
- **Every `tasks/simple/*` "Doing X..." / "Did X: [ COMPLETED ]" pair becomes one `info` line when
  something happened and one `debug` line when nothing did** (X1, X2, X12). The scheduler's own
  `Processing`/`Completed` pair moves to `debug` and gains `ms=`.
- **Security-relevant refusals leave `debug`** (V8): API-key and bearer-token rejections, rate-limit
  bans and the eight unexpected-auth-exception sites in `api/auth/site.ts` go to `warn` (refusal)
  or `error` (exception). The eight are exceptions; the code answers `400 ERR_LOGIN_FAILED` and
  hides the cause even from `logLevel: debug` in production. They are `error`.
- **Graceful shutdown is `info`, not `warn`** (V4, X6). `SIGTERM` joins `SIGINT` as an expected
  reason; anything else keeps the stack.
- **Boot failures always carry the stack** (C3). `error` implies stack in the new formatter, so the
  `IS_DEBUG` branch that decided whether to print it goes away.
- **The flag firehoses are `debug` on their own scopes** (`sql`, `auth`), and turning a flag on
  raises that scope's threshold to `debug` at runtime (see 4.3). They no longer sit at `info` and
  no longer flood the terminal backlog unless the reader asked for them.

## 4. Logger core changes

### 4.1 Fastify through `WIKI.logger`

Give Fastify a pino instance whose destination is a tiny `Writable` that parses each pino record and
re-emits it through `WIKI.logger` with `scope: 'http'` — or, simpler and recommended, set
`disableRequestLogging: true`, keep `genReqId`, and write the access line from one `onResponse` hook:

```ts
app.addHook('onResponse', (req, reply, done) => {
  const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug'
  WIKI.logger[level]('http', `${req.method} ${req.url} → ${reply.statusCode}`, {
    reqId: req.id, ms: reply.elapsedTime, ip: req.ip, userId: …, siteId: …
  })
  done()
})
```

`4xx` at `warn` is the right default for a wiki: a burst of 401/403/404 is exactly what an
operator wants to notice and it is still one line each. `logScopes: { http: debug }` silences it;
`{ http: info }` turns it into a full access log. Fastify's own logger drops to `level: 'warn'` so
its `Reply was already sent` class of diagnostics still surfaces, through the same destination.

`Server listening at …` goes; the `http listening` line replaces it.

### 4.2 Validate `logLevel` (V2)

`logger.init()` refuses anything outside `error|warn|info|debug` with a one-line `console.error`
and exits, the same way `config.ts` treats an unreadable config file. The `verbose`/`silly` names
are gone from `config.sample.yml`'s comment, `base.yml` and the type.

### 4.3 Per-scope thresholds

`logLevel` stays the global floor. A new optional config map raises individual scopes:

```yaml
logLevel: info
logScopes:
  http: debug     # quieten the 4xx lines
  storage: debug  # trace one subsystem without turning everything on
```

The two runtime flags are the same mechanism with a different trigger: `sqlLog` on ⇒ `sql` scope at
`debug`; `authDebug` on ⇒ `auth` at `debug`. `models/flags.ts#authDebug()` becomes a plain
`WIKI.logger.debug('auth', …)` and the flag check moves into the logger's threshold lookup, which
is read per call exactly as `queryLogger` already does.

### 4.4 Context in text mode (C1)

The `key=value` tail is how text mode stops discarding context. `buildErrorLogContext` already
produces the right keys; it needs no change beyond the `scope`.

### 4.5 Backlog and terminal

- Raise `BACKLOG_SIZE` from 100 to 500. With heartbeats at `debug`, 500 lines is hours of real
  history rather than minutes of ticks.
- Stream **structured frames** to the terminal (`{ timestamp, level, scope, message, fields,
  stack? }`) instead of pre-rendered ANSI. The page renders them itself, which is what makes a
  level filter, a scope filter, click-to-expand stacks and a copy-as-JSON button possible without
  the server knowing. This also fixes C7: `util.styleText` strips colour on a non-TTY stdout, so in a
  container the terminal today receives plain uncoloured text and xterm has nothing to render.
  Structured frames make colour the page's job, where it belongs, and let stdout stay plain.
- Rename the page from **Terminal** to **Live log**. It was never a terminal; the name is
  upstream's.

### 4.6 Branding in the log

- The banner says `cardinal <version>`. The `Wiki.js` string leaves `index.ts:98`, the two CLI
  banners, and the `application_name` on every pg connection (`cardinal:<instance>:main`,
  `:worker`, `:events`, `:collab`, `:locks`, `:scheduler`), which is the string an operator sees in
  `pg_stat_activity` and in `api/system/info.ts`'s query. The GitHub strategy's `User-Agent` too.
- `INSTANCE_ID` for a worker becomes `<parent>/w<n>` from the moment the thread starts (N8),
  set from `workerData` rather than the first job.

## 5. New logging

### 5.1 Boot summary and readiness (N1, N7)

- One `boot … starting` line with version, node, instance, config path, and which environment
  overrides were honoured (`overrides=WIKI_PORT,DB_PASS_FILE`).
- One `config` line after the DB merge: how many keys came from the DB blob, whether defaults were
  seeded.
- One `boot ready` line at `setReady()`, with `sites=`, `ms=` since process start, and the URL.
- A `boot stopping reason=SIGTERM` / `boot stopped in 1.2s` pair on shutdown, replacing the four
  lines the HTTP server and scheduler each emit today.

### 5.2 Job outcomes (N3)

`core/scheduler.ts` owns the outcome line so tasks stop repeating it. A task's own `info` line is
only for what it *did* (`purged 12 sessions`). The scheduler emits:

- `debug jobs <task> started  job=<id> attempt=n/m`
- `debug jobs <task> finished  in 12ms` (or `info` when the task returned a non-empty result summary)
- `warn  jobs <task> failed, retrying  attempt=n/m next=<time> error="…"`
- `error jobs <task> failed, no attempts left  attempts=m error="…"` + stack
- `warn  jobs requeued 3 interrupted jobs` on startup reaping, `info` when zero

### 5.3 Login outcomes (N5)

`info auth login  user=<id> strategy=local site=<id>` on success and `warn auth login refused
reason=bad-credentials strategy=local ip=<ip>` on failure — one line each, **coalesced**: the
rate limiter already tracks the key, so after the third refusal from one key in a window the
logger emits one `warn auth login refused 27 times in 60s  ip=…` summary per window instead of 27
lines. The audit table keeps every row; the log keeps the shape of the event.

### 5.4 Content lifecycle (N4)

One `info` line per page create/move/delete/restore and per asset upload/delete, on `pages` /
`assets`, with `site=`, `path=` and `user=`. Renders, drafts and tree bookkeeping stay `debug`.
Navigation rewrites are one `info nav` line. This is the line an operator reaches for when someone
asks "who deleted the onboarding page last Tuesday" and the audit log — which deliberately excludes
pages — cannot answer.

### 5.5 Mail (N6)

`info mail sent  kind=digest to=<userId>`, `warn mail not configured, dropped 4 notifications
kinds=digest,watch` (coalesced per job run), `error mail delivery failed  to=<userId>
error="ECONNREFUSED …"` after the transport's own retries.

### 5.6 Slow queries (N9)

`sqlLog` gains a threshold: `sqlLog: true` logs everything at `debug sql`; a new
`slowQueryMs: 250` (config, default off) logs only queries over it at `warn sql slow query
ms=812 rows=…` with the same parameter redaction. This is the mode operators actually run in
production.

### 5.7 Frontend (N10, 4.6 of the audit)

- `frontend/src/helpers/log.js`: `log.warn(scope, message, err?)` / `log.error(…)`, prefixing
  `[cardinal:<scope>]`, and silent below `error` unless `import.meta.env.DEV` or the site's
  `experimental` flag is on. The 41 `console.*` calls become calls to it; the four phrasings
  become one.
- `app.config.errorHandler` and a `window.addEventListener('unhandledrejection', …)` in a new
  `boot/errors.js`, routed through the same helper. **Not** posted to the server by default: a
  client-error endpoint is an abuse surface and a privacy question, so it is a separate decision
  (a `clientErrorReports` flag, off, if ever).
- Blocks keep plain `console.warn` but adopt the `block-<name>:` prefix `block-pdf` already uses.

## 6. Removals and demotions (the catalogue)

Applies the audit's X-list; sites not listed follow the level policy in 3 mechanically.

| Today | Becomes |
| --- | --- |
| three `=====` lines + `Initializing...` + `Running node.js … [ OK ]` | one `boot … starting` line |
| `Checking DB configuration...`, `Connecting to database...`, `Database connection successful [ OK ]`, `Using PostgreSQL v… [ OK ]`, `Ensuring DB schema exists...`, `Ensuring required DB extensions are installed...`, `Ensuring DB migrations have been applied...` | one `db connected` line with `postgres=`, `schema=`, `migrations=`; the retry loop keeps its `warn db connection failed, retrying attempt=n/10` |
| `Loading settings from DB...` + `Settings merged with DB successfully [ OK ]` | one `config loaded` line |
| `Found 56 locales [ OK ]`, 112 per-locale lines, `Loaded 56 locales into cache [ OK ]` | one `locale loaded 56 locales` line; per-locale at `debug` |
| `Processing new job …` / `Completed job …` | `debug` (5.2) |
| the four-line tick pairs (`storageSyncTick`, `replicationTick`) | one `debug` line when idle; `info storage queued 2 syncs targets=…` when not |
| `Scheduling future planned jobs...` / `Scheduled N …` / `No new …` | one `debug` line |
| `Received event X from instance Y: [ OK ]` | `debug cluster` |
| `warn: Error: SIGTERM` | gone |
| `Extension X is installed. [ OK ]` × N | one `info ext` summary: `installed=puppeteer,sharp missing=… incompatible=…` |
| `Latest version is X.` + `Checked for latest version: [ COMPLETED ]` | silent when current; `info boot update available current=… latest=…` when not |
| `Streaming server logs to user <email>... [ CONNECTED ]` | `info terminal attached user=<id>` |
| `Initializing Worker Pool (Limit: 7)...`, `Starting Scheduler...`, `Scheduler: [ STARTED ]` | one `info jobs scheduler started workers=7` |
| `Registering storage targets for all sites...` + `Registered storage targets for N sites [ OK ]` (and the blocks / comment-provider twins) | one line each, or one combined `info boot synced site modules sites=N` |
| `Collaborative editing initialized successfully: [ OK ]`, `Event Listener initialized successfully: [ OK ]` | `debug`; they are implied by `ready` |
| every `logger.x('… [ FAILED ]')` + `logger.x(err.message)` pair (38) | one call with `error: err` |
| every bare `logger.x(err)` (38) | one call with a message and `error: err` |
| `Purged 0 …` unconditional lines | gated on `count > 0` like their siblings |
| `(STORAGE/GIT)`, `(SEARCH/…)`, `${LOG_PREFIX}`, `[SQL]`, `[AUTH]` prefixes | the scope column |

## 7. What stays

- The single-producer + ring buffer + websocket architecture.
- JSON record shape (`timestamp`, `instance`, `level`, `message`, siblings).
- `helpers/requestLogContext.ts` as the only builder of request context.
- `core/db.ts`'s parameter redaction, verbatim.
- `createSilentLogger()` — extended with `scope()` returning itself.
- The `manage:system` gate on the terminal.
- `docs/operations.md`'s "there is no log file" stance. This review does not propose file output;
  the container's stdout is the log.

## 8. Enforcement

### 8.1 Types

`(scope: LogScope, message: string, fields?: LogFields)`. A bare `Error` as `message` is a type
error; `fields.error` is where it goes.

### 8.2 Lint

`no-console` as an `error` in `backend/.oxlintrc.json`, with `core/config.ts` (pre-logger),
`core/logger.ts` (the sink), `mcp/stdio.ts` (stdout is JSON-RPC) and `scripts/**` / `tasks/*.ts`
CLI entry points carrying a file-level disable and a one-line reason. `frontend/`: `no-console`
as `error` with `helpers/log.js` as the single disable.

### 8.3 Structural test

`backend/test/logging-conventions.test.ts`, the same shape as `api/routeTags.test.ts`: walks the
source tree and fails on `[ OK ]`-style tags, a message ending in `...` or `.`, a message starting
with a capital letter that is not an identifier, `logger.x(err.message)` / `logger.x(err)`
one-liners, a `WIKI.logger.(error|warn|info|debug)(` call whose first argument is not a member of
the scope vocabulary, and any `verbose`/`silly` call. A line that genuinely needs an exception
carries `// log-conventions: allow` with a reason.

### 8.4 Logger unit tests

Add to `core/logger.test.ts`: level threshold per global and per scope; the flag override; backlog
cap; `ws` frame shape; text rendering of `fields` and `error`; `logLevel` validation exit.

## 9. Phased plan

Each phase is a mergeable PR; each item is WP-sized. Phases 0 and 1 are the ones that change what
the log *looks like*; 2 is the one that changes how it *reads*; 3–5 are additive.

| Phase | Items | Effort |
| --- | --- | --- |
| **0 — fixes, no design change** | C2 `return reply` in `api/locales.ts`; V4 `SIGTERM` exemption; V2 `logLevel` validation; X9 e-mail → id in `controllers/terminal.ts`; V3 5xx → `error` | S |
| **1 — logger core** | 2.1–2.4 (scope, fields, text renderer, `error` field, `logFormat: text`), 4.1 (Fastify routed, access line), 4.3 (`logScopes` + flag overrides), 4.5 backlog 500, 4.6 branding, 8.1 types, 8.4 tests | M |
| **2 — call-site sweep** | apply 3 and 6 to all 481 sites; 8.2 lint; 8.3 structural test; `createSilentLogger` update; `docs/operations.md` + `CLAUDE.md` "Logging" section | L (mechanical, but every file is touched — best done in a few PRs by area: `core/`+`tasks/`, `models/`, `modules/`+`api/`+`helpers/`) |
| **3 — new backend logging** | 5.1 boot/ready/shutdown, 5.2 job outcomes, 5.3 login outcomes, 5.4 content lifecycle, 5.5 mail, 5.6 slow queries, N8 worker ids | M |
| **4 — live log page** | 4.5 structured frames; `AdminTerminal.vue` → `AdminLiveLog.vue` with level/scope filters and stack expansion | M |
| **5 — frontend** | 5.7 `helpers/log.js`, `boot/errors.js`, the 41-call sweep, blocks prefix, frontend `no-console` | S |

Phase 2 is where the differentiation lands and it cannot be partial: a log that is half `[ OK ]`
and half `key=value` is worse than either. Phase 1 should therefore ship with the renderer able
to accept *both* the old `(msg)` and the new `(scope, msg, fields)` call shapes for exactly as long
as Phase 2 takes, and Phase 2's last PR deletes the old shape.

## 10. Acceptance

- An idle instance at `logLevel: info` writes **zero** lines per hour after `ready`.
- `docker logs` of a fresh boot is under 15 lines to `ready`, and every one is a state change.
- No pino JSON line reaches stdout in text mode; no line reaches stdout that did not pass through
  `WIKI.logger`.
- `grep -c '\[ OK \]' backend` is 0; `grep -c 'Wiki.js' backend --include='*.ts'` is 0 outside
  `migration/` (which names the *source* product, correctly).
- `logLevel: nonsense` refuses to boot with a one-line reason.
- Every `error`-level line carries a stack; every 5xx carries `reqId`, in both modes.
- The structural test passes and is in `quality.yml`'s backend test step by virtue of the glob.
- Placed side by side, the boot excerpt in the audit's section 3 and the one in section 2.1 here
  would not be recognised as the same product.
