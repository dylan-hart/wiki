# Dependency audit: alternatives, stability and in-house candidates

**Date:** 2026-09-13 · **Scope:** every declared dependency in `backend/`, `frontend/`, `blocks/` and `e2e/` (dependencies, devDependencies and backend `optionalDependencies`), about 207 declarations. · **Trunk:** `scarlett` @ `df032646a`

This audit asks three questions of each package:

1. Is there a **better, more modern, or more stable/reputable** option?
2. Does the package look **weak, shaky or unreliable**?
3. If it does, is it small enough to be worth **rewriting in-house** as a safeguard?

The 2026-08-22 audit (#1152, Epic #1160) covered currency and dead dependencies. This one covers health and alternatives. Settled decisions from that audit (drizzle's `rc` pin, keeping frontend `uuid`, keeping `markdown-it-task-lists` markup) are not reopened.

## Method

- **Live data, not memory.**
  - `npm view` for dist-tags, publish times, maintainers and install scripts.
  - `api.npmjs.org` for weekly downloads (week ending 2026-09-11).
  - `gh api` for repo archival, push dates, open issues, contributor concentration, releases and security advisories.
  - `npm audit` in all four workspaces.
  - `npm ls` and `npm query` for the transitive tree and install scripts.
  - A grep over the source tree, excluding `node_modules`, `assets` and `compiled`, for use sites.
  - Anything that could not be confirmed live is marked **(unverified)** in the group sections.
- **Five parallel research passes** (sections A–E), plus a sixth written directly (F).
- **Independently re-verified** before being put in this summary:
  - the fastify advisories
  - native Temporal in the official Node image
  - the `typographer` bug
  - `akismet-api` having no imports
  - luxon arriving through cron-parser
  - the markdown-it 15.0.x CHANGELOG
  - the undici 8.10.2 security release
  - the sharp advisory ranges
  - the Scarf opt-out
- **Verdicts:**

  | Verdict | Meaning |
  | --- | --- |
  | `KEEP` | Healthy, and no better option exists |
  | `KEEP-WATCH` | Acceptable now, with a named thing to monitor |
  | `CONSIDER-ALTERNATIVE` | A credible better option exists; weigh the migration |
  | `REPLACE` | A clearly better option exists; move |
  | `IN-HOUSE-CANDIDATE` | Shaky, and small enough to own |
  | `REMOVE` | Redundant or dead |

- **Risk** (Low / Med / High) combines exposure (production vs dev, untrusted input or not) with how fragile the package is.

---

## 1. Act now: pins inside published advisories

These pins are currently **inside published security advisories**. Each fix is a patch or minor bump, except the transformers swap.

| # | Package | Pin → target | Why | Section |
| --- | --- | --- | --- | --- |
| 1 | **fastify** | 5.12.1 → ≥ 5.12.4 | 5.12.2 (2026-09-04) fixes **four high** GHSAs: header-validation bypass, `false`-schema bypass, body replacement, and **GHSA-p68q-wchp-6fh7 (auth bypass via malformed URLs reaching encapsulated not-found handlers)**. The last matters because we use encapsulated `contentApp` scopes. **`npm audit` does not show these**: they are on fastify's repo advisories but were not yet in the global advisory index (verified). | A |
| 2 | **@tiptap/\*** (22 packages) | 3.30.2 → 3.31.3 | GHSA-cp6q (`mergeAttributes` `__proto__` → executable DOM attributes, reachable through collaborative content) and GHSA-j95f (high ReDoS). `npm audit` reports `@tiptap/core` high. | C |
| 3 | **nodemailer** | 9.0.5 → ≥ 9.1.1 (10.0.9 preferred) | 4 advisories, including high GHSA-2x7j (addressparser DoS) and two recipient-domain allow-list bypasses. v10 ships its own types, so drop `@types/nodemailer` in the same commit. | B, E |
| 4 | **markdown-it** (frontend + backend) | 15.0.0 → 15.0.2 | Quadratic-complexity fixes in linkify fuzzy links, scheme backscan and smartquotes (CHANGELOG verified). The backend renders **untrusted comments** with `linkify: true`. | D |
| 5 | **sharp** (optional) | 0.35.3 → 0.35.4 | High GHSA-rgj7 (libvips/libheif CVEs). Uploaded images are untrusted input. | F |
| 6 | **undici** | 8.10.0 → 8.10.2 | Security release (verified): 3 high, 1 medium. They sit in interceptors, BalancedPool and WebSocket, which `liveData.ts` doesn't use directly, so real exposure is probably low. It is still a free bump. | A |
| 7 | **@xenova/transformers** | → `@huggingface/transformers` 4.x | The package name has been frozen since 2024-05; the project moved to the Hugging Face org. It is the source of backend's **only critical** audit finding (`protobufjs`), plus 3 highs and a nested `sharp` 0.32.6. The change is confined to `helpers/embeddings.ts` (137 LOC). **Check embedding dimensions and model id before merging**, since stored pgvector data depends on them. | B |

Also bump **pdfjs-dist** 6.2.108 → 6.3.289. It isn't vulnerable (our pin is exactly the high-severity fix floor), but it is a "track latest" package with a third high advisory since 2022.

## 2. Replace or remove: a clearly better option, low cost

| Package | Workspace | Action | Cost | Section |
| --- | --- | --- | --- | --- |
| akismet-api | backend | **REMOVE.** No imports; `comments.ts` now calls Akismet's REST API itself (verified). The 2026-08-22 audit's "live in comments.ts" note is out of date. | 1 line | B |
| s3rver + @types/s3rver | backend (dev) | **REPLACE** with a MinIO or LocalStack container test gated like `hasTestDatabase()`, or drop the one emulated test. The repo is archived, last published 2021, and it carries a permanent **high** `npm audit` finding with no fix. | 1 test file (219 LOC) | B |
| turndown-plugin-gfm | frontend | **REPLACE** with `@joplin/turndown-plugin-gfm` (published 2026-09-07, 3 maintainers, same `tables`/`taskListItems` exports). The original was last published 2018. Re-run the `htmlToMarkdown` tests: headerless tables and `<br>` inside cells behave differently. | 1 import | C |
| @js-temporal/polyfill | backend | **REPLACE.** Drop it (fail fast with a clear message), or point the fallback at `temporal-polyfill` so all workspaces share one polyfill. Last release 2025-03, pre-1.0. See §6.1: it never loads on official Node builds anyway. | small | A |
| cron-parser | backend, frontend | **CONSIDER-ALTERNATIVE → croner.** cron-parser pulls **luxon 3.7.2** into both workspaces (verified), against the "luxon removed entirely" policy, and luxon ends up in the frontend `AdminReplication` chunk. croner has zero dependencies. Check the cron dialect (seconds, `L`/`W`/`#`) against stored expressions. | 5 call sites, ~½ day | A |
| @types/js-yaml | backend | **REMOVE.** js-yaml 5 ships its own types; `tsc --listFiles` never loads `@types/js-yaml`. | 1 line | E |
| @types/markdown-it-emoji | backend | **Local `declare module` shim.** It drags in `@types/markdown-it@14` beside markdown-it 15's bundled types. *(Section E rated it KEEP and section D a shim. D's reason, two disagreeing MarkdownIt type trees, decides it.)* | 3 lines | D |
| cross-env | frontend | **REMOVE.** Archived upstream, one call site. Use `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --mode production`, after confirming `NODE_ENV` handling. | 1 script | E |
| npm-check-updates | backend, frontend, blocks | **REMOVE.** Dependabot already covers all four workspaces weekly. Use `npx npm-check-updates@<ver> -i` on demand, and update the docs that mention `npx ncu -i`. | 3 scripts + doc | E |

## 3. In-house candidates: shaky and small enough to own

These pass both tests: a concerning health signal **and** a replacement small enough that owning it costs less than trusting it.

| Package | Workspace | Why it's shaky | In-house replacement | Section |
| --- | --- | --- | --- | --- |
| **text-case** | frontend | Solo publisher (17★, 100k/wk). Installs **20 sub-packages from the same account**, so 21 packages ride on one set of npm credentials, all for one helper. | ~40 LOC in `helpers/pathHumanize.js`, which already holds the transform rules | C |
| **vue3-otp-input** | frontend | Pre-1.0, solo, no release since 2025-05, on the **login path** | ~150 LOC `WOtpInput.vue` in the shared W\* library (paste split, backspace navigation, `autocomplete="one-time-code"`) | B |
| **sortablejs-vue3** | frontend | Solo, 19k/wk, no release in 12 months | ~70 LOC component or composable over `sortablejs` (2 use sites) | C |
| **rollup-plugin-summary** | blocks (dev) | Solo, 16★, no release since 2025-04. Ships ESLint config as **runtime** dependencies, about 30 transitive packages for cosmetic output. | ~25 LOC `generateBundle` plugin (zlib gzip/brotli + `console.table`), or just delete it | E |
| **markdown-it-expand-tabs** | frontend | Last published 2018, repo idle since 2020. Pulls in `lodash.repeat` despite the lodash ban. | ~15 LOC `renderers/modules/` plugin using `String.prototype.repeat` | D |
| **markdown-it-task-lists** | frontend | Last published 2018, solo. Module-global mutable option state. | **Vendor verbatim** (116 LOC, ISC). The #1180 markup decision is unaffected. | D |
| **filesize** | backend, frontend | Solo, republished ~21× a year for a trivial function | ~20 LOC base-2 JEDEC formatter behind the existing `helpers/fileSize.js` | A |
| **nanoid** | backend | Healthy but solo, and unnecessary on the backend. Three 2026 high advisories on older lines show that even tiny libraries collect CVEs. | ~15 LOC over `node:crypto` (`randomBytes(n).toString('base64url')`) | A |
| **@gquittet/graceful-server** | backend | Bus factor 1 (269 commits vs 1), low adoption, and **owns `process.exit()`** on the shutdown path | ~100 LOC module, or `close-with-grace` (mcollina) plus our own `/_live` and `/_ready` routes | A |

**Promote to in-house if one more advisory lands.** These are shaky today, but only worth owning if their record gets worse:

- **simple-git.** 3 RCE-class advisories in 2026, solo maintainer. The fallback is a thin `execFile('git', [...])` wrapper with fixed argv and `--` separators, 250–400 LOC. It removes exactly the option-parsing surface those bugs lived in.
- **jsonpath-plus.** RCE history through its `eval` feature, and it takes author-supplied paths. **Set `eval: false` now** (one line). The fallback is a restricted-subset evaluator, 60–100 LOC.
- **fast-xml-parser.** One owner across 7 packages, 44 releases a year, 8 GHSAs in 2026, all for one CAS call site. The fallback is a CAS response extractor, 40–60 LOC, refusing entities.
- **tar.** 12 GHSAs in 2026, and it reads **uploaded archives** in `siteImport.ts`. The fallback is `tar-stream`, or a reader and writer for our own export format (~300 LOC).
- **browser-fs-access.** Pre-1.0, effectively solo, idle since 2025-06. The fallback is ~60 LOC (picker, else `<a download>`, else `<input type=file>`).
- **uqr.** Pre-1.0, but a finished domain. The fallback is to vendor its single 27 KB file (Nayuki-derived, MIT).

**Explicitly *not* in-house candidates, despite single-maintainer or advisory-heavy profiles.** Owning these would be strictly worse than a shaky but audited library:

- `@node-saml/node-saml`: XML signature wrapping and canonicalization
- `sanitize-html`: the stored-XSS boundary
- `openid-client`
- `@simplewebauthn/*`
- `bcryptjs`: the exit path is Node's built-in `crypto.argon2`, not our own code
- `ssh2`
- `nodemailer`: SMTP and MIME

## 4. Strategic alternatives worth a spike

None of these is urgent, and each is a real improvement.

| Current | Alternative | Why | Cost | Section |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` 1.x | v2 `@modelcontextprotocol/server` + **`@modelcontextprotocol/fastify`** (GA 2026-07-27) | First-party Fastify adapter. Drops express, hono, cors and express-rate-limit from our tree. v1 has an **unreleased** request-body size-limit hardening fix. | 23 files, mostly imports; 1–2 days | A |
| `poolifier` | `piscina` (piscinajs org: mcollina, jasnell, addaleax…) | poolifier is effectively one developer at 23k/wk; piscina is at 8M/wk | 1–2 days, on the next scheduler rework | A |
| AWS CloudSearch module | Retire it, and add OpenSearch if anyone asks | AWS closed CloudSearch to new customers on **2024-07-25**. No new Cardinal.js install can use it, yet it is about 2.3k LOC under test. | −2.3k LOC | B |
| `rollup` + 4 plugins (blocks) | **Rolldown** (already installed through vitest → vite 8) | One bundler across frontend and blocks. Built-in resolve, CommonJS and minify, plus `rolldown/parseAst`. | Spike: diff `compiled/` and the manifest | E |
| `sass` | Native CSS nesting + existing custom-property tokens | Tailwind 4 discourages preprocessors. The 132 SCSS blocks are mostly plain `$variable` substitution. | Multi-WP cleanup | E |
| `bcryptjs` | Node built-in `crypto.argon2` (argon2id) + rehash-on-login | Removes the dependency and moves to a modern KDF | 1–2 days, **once `crypto.argon2` is stable** | B |
| `pako` (one `inflateRaw`) | Native `DecompressionStream('deflate-raw')` | One fewer dependency | Small async refactor in `block-drawio` | D |
| `monaco-editor` | CodeMirror 6, only if bundle size or mobile editing become priorities | We ship a 6.9 MB `ts.worker`. **First check whether that worker is needed at all.** | Weeks | C |
| `vitest` 4 | vitest 5 (frontend + blocks together) | Auto `clearAllMocks`, no ancestor config lookup. Stay ≥ 4.1.11 until then (patched floor for GHSA-82fw). | 1 WP | E |

## 5. Watch list: shaky signals, no action yet

- **Bus factor 1 on a critical path:**
  - **Collaborative editing:** the Yjs family (yjs, y-protocols, y-websocket, and pre-1.0 lib0). yjs 14 is at rc.26, so plan a coordinated upgrade.
  - **Database:** `pg` (brianc sole publisher, 527 open issues).
  - **Authentication:**
    - `@node-saml/node-saml`: **no release in 14 months, and issue #415 "Vulnerability submission inquiry" has been open since 2026-09-09.** If it becomes an unpatched advisory, evaluate `@boxyhq/saml20` within about 30 days.
    - `@simplewebauthn/*`: take v14 on server and browser together.
  - **SFTP transport:** `ssh2`.
  - **Test environment:** `happy-dom` (3 critical advisories since 2024; the fallback is jsdom, matching blocks).
- **Pre-1.0, or breaking changes outside majors:**
  - `drizzle-orm`/`drizzle-kit`: still rc.4, no rc since 2026-06-27.
  - `oxfmt`: pre-1.0 beta with no output-stability promise. Batch bumps with a full reformat.
  - `js-yaml`: **5.4.0 put breaking changes in a minor release.** Keep exact pins and check `pageSerialization` `dump()` output against fixtures.
  - `asciidoctor` 4.x: a fresh native rewrite, 11 patch releases in 8 weeks, one committer, no renderer tests.
  - `leaflet`: 2.0 stuck at alpha. 1.9.4 is fine for our 4-call surface.
- **High advisory cadence (fast fixes, so track latest):**
  - `sanitize-html` (5 in 2026)
  - `mermaid` (11 in 2025–26; **12.0 re-lays out every existing diagram**, so adopt it deliberately)
  - `@fastify/static` (path canonicalisation)
  - `pdfjs-dist`
  - `vue-i18n` (prototype pollution history)
- **Process concerns:**
  - `markdown-it-attrs`: one human maintainer, and 14 of its last 30 commits were authored by Copilot on an attribute-injection parser. Review each bump's diff, and keep a test that non-whitelisted attributes are dropped.
  - `highlight.js`: revived in 2026-06 after a dormant year. Switch the backend's full import to `lib/common` to shrink the server-side grammar and ReDoS surface.
- **Supply chain:**
  - `twemoji-assets` is a GitHub **tag** tarball. The lockfile integrity hash makes it fail-closed, but the release is not immutable, Dependabot can't update it, and it installs a second `@twemoji/api` plus the `@twemoji/parser@17.0.2` our override avoids. **Pin the URL by commit SHA.**
  - `@twemoji/api`: 29k/wk, 2 people, and a patch release that regressed matching.
- **Stale but finished (fine):** `mitt`, `d3-*`, `lowlight`, `qrcode`, `aws-sdk-client-mock`, `mime` (watch its type-table staleness), `sortablejs` (527 open issues; the fallback is `@atlaskit/pragmatic-drag-and-drop`).

## 6. Cross-cutting findings

### 6.1 Documentation that is factually wrong

- **Temporal is native on official Node 26 builds.**
  - `docker run node:26.8.1-slim node -e "typeof Temporal"` → `object` (verified). This Mac's Homebrew Node 26.8.1 gives `undefined` (verified).
  - So CLAUDE.md's "verified … `typeof Temporal` is `undefined`" and the header of `core/temporal.ts` describe a build compiled without Temporal (`v8_enable_temporal_support=0`), not Node 26 itself.
  - `ensureTemporal()` is a no-op in CI, the devcontainer and the production image. Correct the doc when acting on the §2 polyfill item. Keeping *a* fallback for Homebrew-style builds is still reasonable.
- **"luxon has been removed entirely"** holds only for direct dependencies: `npm ls luxon` shows luxon 3.7.2 through `cron-parser` in backend and frontend (verified).
- **The 2026-08-22 audit memory's "akismet-api is live in comments.ts"** is out of date (0 imports, verified).

### 6.2 `npm audit` is necessary but not sufficient

The fastify advisories were published on the fastify repo on 2026-09-04 and had still not reached the global advisory index nine days later, so `npm audit` stayed silent about four high-severity bugs in our HTTP layer.

For the handful of packages that sit on a trust boundary, **watch the upstream repository's own security advisories** rather than relying only on `npm audit` or Dependabot alerts: fastify, @fastify/\*, sanitize-html, @node-saml/node-saml, openid-client, markdown-it, @tiptap/core, nodemailer, tar and pdfjs-dist.

Snapshot on 2026-09-13:

| Workspace | Total | Critical | High | Moderate | Low | Main sources |
| --- | --- | --- | --- | --- | --- | --- |
| backend | 13 | 1 | 8 | 4 | 0 | `@xenova/transformers` (protobufjs, onnx, nested sharp), `s3rver` (busboy/dicer, old fast-xml-parser), `nodemailer`, `sharp`, `gaxios`→`uuid` |
| frontend | 51 | 0 | 3 | 47 | 1 | `@tiptap/core` (45 `@tiptap/*` entries, fixed by 3.31.3), `immutable` (through sass), `browserslist`/`baseline-browser-mapping` (build tooling, not traced), `dompurify` (bundled in monaco) |
| blocks | 3 | 0 | 3 | 0 | 0 | `swagger-ui`'s nested `js-yaml` 4, `@xmldom/xmldom` (MathJax → speech-rule-engine) |
| e2e | 0 | 0 | 0 | 0 | 0 | — |

Doing §1 and §2 clears every backend critical and high except transitive stragglers, and all 45 `@tiptap` entries.

### 6.3 Install scripts and native builds in the tree

| Workspace | Packages that run install scripts | Origin |
| --- | --- | --- |
| backend | `puppeteer` (browser download), `ssh2` + `cpu-features` (native addon), `esbuild` | optional dependency; `ssh2-sftp-client`; `drizzle-kit` |
| frontend | `@parcel/watcher` | `sass` |
| blocks | `@scarf/scarf` (**install telemetry**), `tree-sitter` ×2, `tree-sitter-json`, `@tree-sitter-grammars/tree-sitter-yaml` (native compiles), `core-js-pure` | all through **`swagger-ui`** / `swagger-client` |

- Scarf telemetry is already disabled by `"scarfSettings": { "enabled": false }` in `blocks/package.json` (verified).
- `swagger-ui` is by far the heaviest supply-chain contributor in `blocks/`: native tree-sitter builds, core-js, a nested `js-yaml` 4 with a high advisory, and a 1.59 MB bundle.
- It remains the right choice, since `@scalar/api-reference` was already rejected for breaking shadow-root styling and RapiDoc is stale. But it is the one to reassess if an alternative that works inside a shadow root appears.

### 6.4 Duplication in the tree

- **Two Temporal polyfills** (`@js-temporal/polyfill` in backend, `temporal-polyfill` in frontend and blocks) → one (§2).
- **Two `sharp`** (top-level 0.35.3, nested 0.32.6 under transformers) → one after §1 #7. Check `npm ls sharp`, since the successor's `^0.34.5` range may still nest.
- **Two `@twemoji/api`** (the direct pin plus `twemoji-assets`, which *is* the package) → document or pin by SHA.
- **`js-yaml` 4 and 5** in blocks (through `swagger-ui` and `rollup-plugin-summary`).
- **`highlight.js`:** the backend imports every grammar and the frontend imports `lib/common`. Align the backend to `lib/common`.
- **KaTeX + MathJax:** justified. 2.5.x offered both, the TeX coverage differs, and both are lazily loaded blocks.

### 6.5 Found along the way (not dependency health)

- **Bug:** `frontend/src/renderers/markdown.js:221` passes `typography: config.typographer`. markdown-it's option is `typographer` and unknown keys are ignored, so **the admin Typographer toggle and quote-style setting do nothing today.** No test covers it. (Verified.)
- **Undeclared imports:** `EditorWysiwyg.collab.test.js` imports `@tiptap/core` and `@tiptap/y-tiptap`, which resolve only as transitive dependencies. Declare them as devDependencies.
- **nodemon restarts use `SIGUSR2`,** which is not in the backend's graceful-shutdown signal set. Add `--signal SIGTERM` to `npm run dev`. (Dev behaviour unverified.)
- **The `jsonpath-plus` call** doesn't pass `eval: false` explicitly (§3).

---

# Group sections

Every package gets a table row and a per-package entry with evidence. Sections A–E are the research passes' output; section F was written directly.


---

## A. Backend core: HTTP, runtime, data, collab and utility libraries

Audit date 2026-09-13. Live sources: `npm view` (dist-tags, version `time`, maintainers), `gh api repos/*` (archived, pushed_at, open issues, contributors), `api.npmjs.org` weekly downloads (week ending 2026-09-11), `gh api /advisories`, release notes via `gh api .../releases`, and runtime checks in the official `node:26.7.0` / `node:26.8.1` Docker images. Use-site counts are non-test source files importing the package (test files in brackets), from a grep of `backend/ frontend/ blocks/ e2e/` that skips `node_modules`, `assets` and `compiled`. "Maint" means npm publish rights; "top contrib" means GitHub commit count.

| Package | Workspace(s) | Pinned → Latest | Last publish (latest) | Maintainers/backing | Verdict | Risk |
|---|---|---|---|---|---|---|
| fastify | backend | 5.12.1 → 5.12.4 | 2026-09-11 | fastify org (OpenJS), 6 maint | KEEP (**bump now**: 4 high GHSAs) | High until bumped |
| @fastify/compress | backend | 9.2.0 = latest | 2026-08-08 | fastify org | KEEP | Low |
| @fastify/cookie | backend | 11.1.2 = latest | 2026-07-15 | fastify org | KEEP | Low |
| @fastify/cors | backend | 11.3.0 = latest | 2026-07-08 | fastify org | KEEP | Low |
| @fastify/formbody | backend | 9.0.0 = latest | 2026-08-08 | fastify org | KEEP | Low |
| @fastify/helmet | backend | 13.1.1 = latest | 2026-08-19 | fastify org | KEEP | Low |
| @fastify/multipart | backend | 10.1.1 = latest | 2026-08-14 | fastify org | KEEP | Low |
| @fastify/proxy-addr | backend | 5.1.0 = latest | 2025-09-28 | fastify org | KEEP | Low |
| @fastify/sensible | backend | 6.0.5 = latest | 2026-08-08 | fastify org | KEEP | Low |
| @fastify/session | backend | 11.1.2 = latest | 2026-07-15 | fastify org | KEEP-WATCH | Low |
| @fastify/static | backend | 10.1.3 = latest | 2026-08-06 | fastify org | KEEP-WATCH | Med |
| @fastify/swagger | backend | 9.8.1 = latest | 2026-07-13 | fastify org | KEEP | Low |
| @fastify/swagger-ui | backend | 6.1.1 = latest | 2026-07-28 | fastify org | KEEP | Low |
| @fastify/websocket | backend | 11.3.0 = latest | 2026-07-08 | fastify org | KEEP | Low |
| @gquittet/graceful-server | backend | 6.1.0 = latest | 2026-08-18 | 1 person (gquittet) | CONSIDER-ALTERNATIVE (close-with-grace or in-house) | Med |
| undici | backend | 8.10.0 → 8.10.2 | 2026-09-04 | Node.js org | KEEP (bump) | Med |
| poolifier | backend | 5.3.2 = latest | 2026-02-23 | poolifier org, effectively 1 dev | CONSIDER-ALTERNATIVE (piscina) | Med |
| emittery | backend | 2.0.0 = latest | 2026-03-04 | sindresorhus | KEEP | Low |
| lru-cache | backend | 11.5.2 = latest | 2026-07-07 | isaacs (1) | KEEP | Low |
| commander | backend | 15.0.0 = latest | 2026-05-29 | 2 maint, tj org repo | KEEP | Low |
| cron-parser | backend, frontend | 5.10.0 → 5.10.1 | 2026-09-12 | 1 (harrisiirak) | CONSIDER-ALTERNATIVE (croner) | Med |
| js-yaml | backend, frontend(dev), blocks | 5.3.0 → 5.4.2 | 2026-09-13 | nodeca org, 1 npm maint | KEEP-WATCH | Med |
| semver | backend, frontend | 7.8.5 = latest | 2026-06-19 | npm org | KEEP | Low |
| nanoid | backend | 6.0.1 = latest | 2026-08-03 (v6 line) | 1 (ai) | CONSIDER-ALTERNATIVE (node:crypto) | Low |
| mime | backend | 4.1.0 = latest | 2025-09-12 | 1 (broofa) | KEEP-WATCH | Low |
| filesize | backend, frontend | 11.0.22 → 11.0.23 | 2026-09-03 | 1 (avoidwork) | IN-HOUSE-CANDIDATE | Low |
| es-toolkit | backend, frontend | 1.51.0 → 1.52.0 | 2026-08-28 | Toss org | KEEP | Low |
| @js-temporal/polyfill | backend | 0.5.1 = latest | 2025-03-31 | TC39 champions (Igalia et al.) | REPLACE (drop or use temporal-polyfill) | Med |
| temporal-polyfill | frontend, blocks(dev) | 1.0.4 → 1.0.5 | 2026-09-11 | 1 (arshaw / FullCalendar) | KEEP-WATCH | Low |
| zod | backend | 4.4.3 → 4.6.5 | 2026-09-13 | 1 (colinhacks) | KEEP | Low |
| @modelcontextprotocol/sdk | backend | 1.30.0 = latest | 2026-07-27 | MCP org (Anthropic) | CONSIDER-ALTERNATIVE (v2 `@modelcontextprotocol/server` + `/fastify`) | Med |
| acorn | backend | 8.18.0 = latest | 2026-07-28 | acornjs org (marijn) | KEEP | Low |
| jsonpath-plus | backend | 10.4.0 = latest | 2026-02-16 | 2 (brettz9) | KEEP-WATCH | Med |
| fast-xml-parser | backend | 5.11.0 → 5.11.1 | 2026-08-27 | 1 (amitgupta) | KEEP-WATCH | Med |
| tar | backend | 7.5.22 = latest | 2026-07-24 | isaacs (1) | KEEP-WATCH | Med |
| diff | backend | 9.0.0 = latest | 2026-04-13 | 2 (kpdecker, ExplodingCabbage) | KEEP | Low |
| lib0 | backend | 0.2.117 = latest | 2025-12-30 | 1 (dmonad) | KEEP-WATCH | Med |
| yjs | backend, frontend | 13.6.32 = latest (14.0.0-rc.26 pending) | 2026-08-04 | 1 (dmonad), yjs org | KEEP-WATCH | Med |
| y-protocols | backend | 1.0.7 = latest | 2025-12-16 | 1 (dmonad) | KEEP-WATCH | Med |
| y-websocket | frontend | 3.1.0 = latest | 2026-08-06 | 1 (dmonad) | KEEP-WATCH | Med |
| drizzle-orm | backend | 1.0.0-rc.4 = `rc` tag | 2026-06-27 (rc.4) | Drizzle Team (company), 4 maint | KEEP-WATCH | Med |
| drizzle-kit | backend(dev) | 1.0.0-rc.4 = `rc` tag | 2026-06-27 (rc.4) | Drizzle Team | KEEP-WATCH | Med |
| pg | backend, e2e(dev) | 8.23.0 = latest | 2026-08-08 | 1 (brianc) | KEEP-WATCH | Med |
| pg-cursor | backend | 2.22.0 = latest | 2026-08-08 | 1 (brianc) | KEEP | Low |

---

### fastify
- **Use:** the whole HTTP layer. 126 source files [104 test].
- **Health:** 24 stable releases in the last 12 months. 9.5M downloads/wk, 37.1k stars, repo pushed 2026-09-13, 154 open issues, OpenJS Foundation project. A `6.0.0-alpha.3` is on `next`.
- **Security (key finding):** the 5.12.2 security release (2026-09-04) fixes four **high** GHSAs, and every one affects our pin of 5.12.1:
  - GHSA-9q9j-q6p8-xq58: header validation bypass
  - GHSA-hwr6-493r-vm6h: validation bypass through boolean `false` schemas
  - GHSA-p68q-wchp-6fh7: auth bypass when a malformed URL reaches an encapsulated not-found handler
  - GHSA-667r-xxjv-c9mm: request body replacement through an async validation collision

  We lean on encapsulated plugins, including `siteEnabledPreHandler` on `contentApp`, so p68q is directly relevant. At the time of the check these four did not appear in the global `/advisories?affects=fastify` listing, so `npm audit` may not flag them yet.
- **Alternatives:** none better. Hono and Express would be a rewrite with no upside.
- **Shakiness:** none. The advisory rate is high, but fixes ship fast and are backported.
- **Verdict: KEEP**, and bump to ≥5.12.4 immediately. Watch the v6 timeline.

### @fastify/* plugins (compress, cookie, cors, formbody, helmet, multipart, proxy-addr, sensible, session, static, swagger, swagger-ui, websocket)
- **Use:** each is registered once, mostly in `core/http/{server,security,session,openapi}.ts`, plus `api/pages/import.ts` (multipart), `models/security.ts` (proxy-addr) and `helpers/authSecretSigner.ts` (cookie). sensible has 3 source files [12 test]. The rest have 1–2.
- **Health:** all live in the fastify GitHub org, with 7–18 npm maintainers each (mcollina, Eomm, climba03003, Fdawgs and others). All 13 were re-published on 2026-09-04 (npm `time.modified`). Every pin equals `latest`. Downloads run from 0.14M/wk (session) to 7.8M/wk (proxy-addr). None is archived.
- **Advisories, all fixed at our pins:**
  - @fastify/static: GHSA-83w8-p2f5-377r (high, ≤10.1.0) and GHSA-8pvw-jcv7-9cmj (medium, non-canonical-path auth bypass, ≤10.1.1). That is four advisories in 2026, and 13 releases in 12 months.
  - @fastify/session: GHSA-pj27 (2024, <10.9.0).
  - @fastify/multipart: GHSA-27c6 (2025, ≤8.3.0).
- **Alternatives:** none needed. @fastify/session is the least-used plugin here (142k/wk, 16 open issues), and `@fastify/secure-session` would be stateless. That doesn't fit our db-backed session store, so no change.
- **Shakiness:** low. Org-backed, with multiple publishers per package.
- **Verdict: KEEP**, with **KEEP-WATCH** on @fastify/static (repeated path-canonicalisation advisories on a route that serves `assets/`) and @fastify/session (smaller user base).

### @gquittet/graceful-server
- **Use:** `core/http/server.ts`, one call. It wraps `app.server` and provides `/_live` and `/_ready`, `closePromises` (scheduler, collab, db), a 5 s pre-close delay, and a `SHUTTING_DOWN` event. The library calls `process.exit()` itself.
- **Health:** one npm maintainer. On GitHub, gquittet has 269 commits and the next human contributor has 1. 40.5k downloads/wk, 348 stars, 1 open issue. 14 releases in 12 months, many of them dependency bumps. Repo is active (last push 2026-08-18).
- **Alternatives:**
  - `close-with-grace` 2.5.0: mcollina, 353k/wk, the pattern the Fastify docs use. It handles signals and uncaught errors with a delay but has no probe endpoints. We would add two small `/_live` and `/_ready` routes gated on a flag.
  - An in-house module. Signal handling, an `isReady` flag, the two probe routes, a pre-close delay, `Promise.allSettled` with a timeout, then `app.close()`: about 80–120 LOC plus tests.
- **Shakiness:** bus factor 1 on the process-lifecycle path, and low adoption. The library owning `process.exit()` has already caused us workarounds (the synchronous-write comment at `server.ts:303`).
- **Verdict: CONSIDER-ALTERNATIVE.** Move to `close-with-grace` plus our own probe routes (the preferred option), or an in-house module of about 100 LOC. It is not urgent, since the package works and is maintained.

### undici
- **Use:** `models/liveData.ts`, one use. It builds a per-request `Agent` with a pinned DNS `lookup` (SSRF defence) and passes it as `dispatcher` to the **global** `fetch`.
- **Health:** Node.js org. 134.7M downloads/wk. 54 releases in 12 months across the v6, v7 and v8 lines. Heavy advisory traffic: 20 GHSAs in 2026. 8.10.2 (2026-09-04) fixes high GHSA-vp8m, w293 and rfgv plus medium 3wwx. Those are in interceptors, BalancedPool and WebSocket, which liveData doesn't use (unverified that no transitive path does).
- **Note:** official Node 26.8.1 bundles `process.versions.undici` = 8.10.0, and it has no public API for `Agent`. So the npm package is the right way to get a dispatcher. Mixing npm undici's `Agent` with the *global* fetch only works while the major versions match. undici's docs recommend importing `fetch` from the same package (unverified that the docs still say so). Doing that removes the coupling to the Node release.
- **Verdict: KEEP.** Bump to 8.10.2 and consider `import { fetch, Agent } from 'undici'` in liveData.

### poolifier
- **Use:** `core/scheduler.ts` (`FixedThreadPool` / `DynamicThreadPool`) and `worker.ts` (`ThreadWorker`), plus 3 test fixtures. Roughly 30 lines touch the API.
- **Health:** 23.4k downloads/wk, 454 stars, 19 open issues. The repo is very active (pushed 2026-09-14, 5 stable releases in 12 months). On npm the publishers are pioardi and fraggle, but on GitHub `jerome-benoit` has 5,083 commits against 264 for the next human. The effective bus factor is 1, and adoption is low.
- **Alternatives:**
  - `piscina` 5.3.2: the piscinajs org, with publishers metcoder95, mcollina, jasnell, qard, addaleax and rafaelgss. 8.0M/wk, 5.2k stars, 7 open issues, pushed 2026-09-11. It supports min/max threads (fixed or dynamic), `idleTimeout` and task queues.
  - `tinypool` (2.2.0, 34.5M/wk) is lighter, but it's Vitest-oriented.
- **Migration cost:** moderate. It touches `scheduler.ts` pool construction, the worker entry's export shape (piscina wants a default-exported function instead of `new ThreadWorker(fn)`), the crash and identity test fixtures, and any use of poolifier's worker-choice or event API. Estimate 1–2 days including the scheduler test suites.
- **Verdict: CONSIDER-ALTERNATIVE (piscina).** The case is reputation and bus factor, not a defect. Do it when the scheduler is next reworked.

### emittery
- **Use:** `WIKI.events.{inbound,outbound}` in `index.ts`: `emit`, `on`, `onAny`, `offAny` and `clearListeners`, over about 15 call sites.
- **Health:** sindresorhus. 33.5M downloads/wk, 0 open issues, 2.0.0 released 2026-03. Low churn.
- **Alternatives:** `node:events` EventEmitter, but its `emit` is synchronous and doesn't await async listeners, which emittery does. Swapping would change semantics for no gain.
- **Verdict: KEEP.**

### lru-cache
- **Use:** 5 sites: `WIKI.cache`, the `mcp/http.ts` session map, the icons not-found cache and the rate-limit ban memo. TTL is used.
- **Health:** isaacs as sole publisher, but 408M downloads/wk and 3 open issues. 17 releases in 12 months, no advisories. Its `prepare` script doesn't run on registry installs.
- **Alternatives:** none built in. A `Map`-based LRU is ~40 LOC, but TTL, size accounting and fetch semantics make that a false economy.
- **Verdict: KEEP.** The bus factor is 1, but the package is ubiquitous enough that the ecosystem would fork it.

### commander
- **Use:** the 2.5.x migration CLI: `migration/source-args.ts`, `cli.ts` and `verify-cli.ts`. About 17 option declarations, plus `InvalidArgumentError` and generated help.
- **Health:** 371M downloads/wk, 28.4k stars. shadowspawn has been the steady maintainer (572 commits), with abetomo also publishing. v15 shipped 2026-05, and there are 8 open issues.
- **Alternatives:** `util.parseArgs`, available on Node 26, has no help, custom validators or typed errors. We would rebuild about 60–100 LOC of help and validation.
- **Verdict: KEEP.** It's healthy and the swap would add code.

### cron-parser
- **Use:** backend `core/scheduler.ts`, `api/replication.ts` and `models/replication.ts`, plus frontend `pages/AdminReplication.vue` (next-run preview). Only `CronExpressionParser.parse(...)` is used, 4 call sites.
- **Health:** one maintainer (harrisiirak, 339 commits; next contributor 19). 14.7M downloads/wk, 11 open issues, active (5.10.1 released 2026-09-12). No advisories.
- **Hidden cost:** it depends on `luxon ^3.7.2`, confirmed in 5.10.1's `dependencies`. `npm ls luxon` shows luxon 3.7.2 installed in **both** backend and frontend through cron-parser. So the "luxon removed entirely" claim in CLAUDE.md holds for our direct dependencies only. On the frontend, luxon ships inside `AdminReplication-*.js` (102.5 kB raw / 31.5 kB gzip, where the string "Luxon" appears 6 times) for a single admin page.
- **Alternatives:** `croner` 10.0.1 (Hexagon): zero dependencies, 6.8M/wk, 2.6k stars, 3 open issues, pushed 2026-08-31. `new Cron(expr).nextRuns(n)` covers the preview and next-run use. It is also single-maintainer, but it drops luxon and the second date library.
- **Migration cost:** 4 call sites plus a check that croner's cron dialect matches what we already store (seconds field, `L`/`W`/`#`). About half a day.
- **Verdict: CONSIDER-ALTERNATIVE (croner).** It removes a transitive date library the project policy bans, and it shrinks a frontend chunk.

### js-yaml
- **Use:** backend `core/config.ts`, `helpers/moduleRegistry.ts` and `helpers/pageSerialization.ts` (`load`/`dump`) [26 test files]. Frontend dev: `vite.config.js`. blocks runtime: `block-openapi` and `block-infobox` (`CORE_SCHEMA`, `timestampTag`).
- **Health:** nodeca org, but npm publish rights sit with one account (vitaly). 216M downloads/wk, 4 open issues. 19 releases in 12 months, with active v3, v4 and v5 lines.
- **Advisories:** 11 GHSAs on record, 7 of them published 2025-11 to 2026-09 (mostly parser DoS). Our 5.3.0 is past GHSA-pm4m (≤5.2.1). 5.4.1 (2026-08-26) adds merge-key CPU hardening with no GHSA of its own. 5.4.0 put `[breaking]` changes in a **minor** release (AST node shape, `sortKeys`, scalar quoting style). That could change `dump()` output in page serialization and exports.
- **Alternatives:** `yaml` (eemeli): 143M/wk, 1.7k stars, pushed 2026-09-13, also effectively single-maintainer. It is not clearly better, and a swap would re-validate every YAML round trip.
- **Verdict: KEEP-WATCH.** Take 5.4.x for the hardening, but check `dump()` output from `pageSerialization.ts` against fixtures, because of the breaking change in a minor. Keep an exact pin: SemVer here isn't trustworthy.

### semver
- **Use:** backend `index.ts` (the Node ≥26 check), `tasks/simple/check-version.ts` and `core/db.ts` (`coerce`). Frontend `stores/admin.js` (`semver/functions/gte`).
- **Health:** npm org, 619M downloads/wk. fastify already depends on it, so it stays in the tree regardless.
- **Verdict: KEEP.**

### nanoid
- **Use:** 8 calls in 5 backend files. Most are security-sensitive: the OAuth `state`, `nonce` and `codeVerifier`, the SAML request id, a random password, a credential token, plus `INSTANCE_ID` via `customAlphabet`. `userCredentials.ts:779` writes `await nanoid()`, which is harmless because nanoid is synchronous.
- **Health:** one maintainer (ai, 1,030 commits). 179M downloads/wk, 27k stars, 0 open issues. Highly reputable. Three **high** GHSAs in 2026 (xwg4, 28wg, 2v37) hit the 3.x/5.x lines, not v6. v6 narrowed `engines` to `^22 || ^24 || >=26`.
- **Alternatives:** `crypto.randomBytes(n).toString('base64url')`, or `crypto.randomUUID()` for ids, in `node:crypto`. They're equally strong, have no dependency and are always present on the backend. `customAlphabet('0-9a-f', 10)` becomes `randomBytes(5).toString('hex')`. That's a 10–15 LOC helper.
- **Verdict: CONSIDER-ALTERNATIVE (node:crypto).** It's low priority and low risk. The backend doesn't need a dependency for random tokens, and the 2026 advisory streak shows even tiny libraries get CVEs.

### mime
- **Use:** `models/assets.ts`, `modules/storage/git/sync.ts` and `helpers/common.ts`, about 4 `getType`/`getExtension` calls.
- **Health:** broofa (also maintains uuid), 111M downloads/wk. No release since 4.1.0 (2025-09-12), though commits continued through 2026-04 (trusted publishing). 6 open issues. The only advisory is from 2018.
- **Concern:** the type table ships inside the package. A year without a release means newer types won't be recognised (unverified which ones).
- **Alternatives:** `mime-types` from the jshttp org (on mime-db, unverified current health), if staleness ever bites.
- **Verdict: KEEP-WATCH** for type-table staleness.

### filesize
- **Use:** 2 call sites. Backend `api/system/info.ts` (`ramTotal`) and frontend `helpers/fileSize.js` (`{ base: 2, standard: 'jedec' }`, used by 4 files).
- **Health:** one maintainer (avoidwork, 445 commits). 11M downloads/wk. 21 releases in 12 months, mostly patches. Has a husky `prepare`. No advisories.
- **In-house:** base-2 JEDEC formatting (`B`, `KB`, `MB`, …, with rounding) is about 15–20 LOC plus a table test. `Intl.NumberFormat` with `style: 'unit', unit: 'megabyte'` covers the decimal units but not JEDEC labels.
- **Verdict: IN-HOUSE-CANDIDATE.** It's a trivial function sitting behind a frequently republished single-maintainer package, and it already has a wrapper (`helpers/fileSize.js`) to swap behind. Low priority.

### es-toolkit
- **Use:** 25 backend and 29 frontend files through subpath exports. Most common: debounce ×12, isPlainObject ×6, chunk ×6, toMerged ×5, uniq ×4, cloneDeep ×4.
- **Health:** Toss (company). 36.9M downloads/wk, 11.3k stars, 51 open issues. 17 stable releases in 12 months plus automated `dev` pre-releases. Project policy mandates it.
- **Alternatives:** some calls could be native (`cloneDeep` → `structuredClone`, `uniq` → `new Set`, `isEqual` → `util.isDeepStrictEqual` on the backend). That would be tidying, not a risk fix.
- **Verdict: KEEP.**

### @js-temporal/polyfill (backend) and temporal-polyfill (frontend, blocks): duplication
- **Use:** backend `core/temporal.ts` `ensureTemporal()`, plus `test/temporal.ts`. Frontend `boot/temporal.js` (a lazy import, for Safari) and `test/setup.js`. blocks `test/setup.js` (dev only).
- **Key finding, verified live:**
  - The **official** `node:26.7.0-bookworm-slim` and `node:26.8.1-bookworm-slim` images report `typeof Temporal === 'object'`, `Date.prototype.toTemporalInstant` present, and `v8_enable_temporal_support=1`.
  - The Homebrew Node 26.8.1 on this Mac reports `v8_enable_temporal_support=0` and `typeof Temporal === 'undefined'`.
  - So CLAUDE.md's statement that it was "verified against a real Node 26.7.0 binary: `typeof Temporal` is `undefined`" is true only for a distro or Homebrew build compiled without Temporal. In CI (setup-node 26.8.1, which uses official binaries, unverified), the devcontainer (`node:26.8.1`) and production (`dev/build/Dockerfile` → `node:26.7.0-bookworm`), `ensureTemporal()` is a no-op and the backend polyfill never loads.
- **Health:**
  - `@js-temporal/polyfill`: last release 0.5.1 on 2025-03-31, still pre-1.0. Last commit 2026-05-14 (a README change); before that, test262 updates in 2025-11. It carries a `jsbi` dependency. 2.08M downloads/wk, 55 open issues.
  - `temporal-polyfill` 1.0.5 (FullCalendar): released 2026-09-11, 7 releases in 12 months, 2.64M/wk, 4 open issues. arshaw has 2,518 commits, so the bus factor is 1.
- **Alternatives:** use one polyfill everywhere. Either drop the backend polyfill and make `ensureTemporal()` fail fast with a clear "this Node build lacks Temporal" message, or keep a fallback for builds like Homebrew's and point it at `temporal-polyfill` (`temporal-polyfill/global` also patches `toTemporalInstant`). Backend tests need the same change.
- **Verdict:** `@js-temporal/polyfill` **REPLACE** (drop it, or switch to temporal-polyfill). `temporal-polyfill` **KEEP-WATCH**: bus factor 1, and only needed until Safari ships Temporal.
- **Doc impact:** the Temporal paragraphs in CLAUDE.md and the `core/temporal.ts` header are factually wrong for official builds and should be corrected.

### zod
- **Use:** 15 files, all under `mcp/tools/*` (tool input schemas).
- **Health:** colinhacks (1,073 commits), 209M downloads/wk, 43.9k stars, 51 open issues. v4 is stable. 29 stable releases in 12 months plus canaries. The only advisory is from 2023 (3.x).
- **Pin:** 4.4.3 vs 4.6.5. MCP SDK 1.30 accepts `^3.25 || ^4.0`, and v2 requires `^4.2.0`.
- **Verdict: KEEP.** Bump with the MCP work.

### @modelcontextprotocol/sdk
- **Use:** 23 files. `server/mcp.js` ×20, `types.js` ×21, `streamableHttp.js` ×2, `stdio.js`, `shared/transport.js`.
- **Health:** MCP org (Anthropic staff publish). 41M downloads/wk, but 610 open issues. Three high GHSAs, 2025-12 through 2026-02, all fixed before 1.25.3.
- **Status change:** `@modelcontextprotocol/server@2.0.0` (npm `latest`), `/node`, `/hono` and **`/fastify`** (peer `fastify ^5.2.0`) all went GA on 2026-07-27, the same day as 1.30.0. v1 lives on a `v1.x` branch, which has an **unreleased** fix from 2026-08-25: "read HTTP request bodies with a size limit and bound JSON-RPC batch length". No 1.30.1 exists yet.
- **Dependency weight:** v1's runtime dependencies include express, hono, @hono/node-server, cors, express-rate-limit, cross-spawn, jose and more. We use none of them, since we run Fastify. v2's `server` depends only on `@modelcontextprotocol/core` and `zod`.
- **Alternatives:** migrate to v2 `server` plus the `fastify` adapter. A codemod exists, `npx @modelcontextprotocol/codemod v1-to-v2` (this came from search results; I didn't check the exact package tag).
- **Migration cost:** 23 files of mostly mechanical import changes, plus the transport and session layer in `mcp/http.ts`. About 1–2 days with the MCP session harness tests. The v2 spec (2026-07-28) was still called an "RC" in the MCP blog post, so confirm it has settled (unverified).
- **Verdict: CONSIDER-ALTERNATIVE (v2 split packages).** It's the same project's successor, it has a first-party Fastify adapter and a far smaller transitive tree. Meanwhile, watch for a 1.30.1 carrying the body-size fix.

### acorn
- **Use:** `helpers/blockDefinition.ts` (284 lines), which parses a block's `static definition` literal.
- **Health:** acornjs org (marijn). 181M downloads/wk, 15 open issues. Last advisory 2020.
- **Verdict: KEEP.**

### jsonpath-plus
- **Use:** `helpers/jsonPath.ts`, one call. `JSONPath({ path, json, wrap: true })` with **author-supplied** paths from `block-live-data`.
- **Health:** JSONPath-Plus org, brettz9 the main maintainer (321 commits). 8.8M downloads/wk, 51 open issues. One release in 12 months (10.4.0 on 2026-02-16).
- **Advisories:** RCE history. Critical GHSA-pppg (2024, ≤6.0.1) and high GHSA-hw8r (2025, <10.3.0), both from its `eval` script-expression feature. We call it without an explicit `eval` option and rely on the 10.x default ("safe" evaluation, unverified exactly which filter syntax that still allows).
- **Alternatives:** pass `eval: false` explicitly (a one-line hardening step). An RFC 9535 implementation without script evaluation is another route (candidates not assessed live). An in-house subset (dot and bracket member access, array index, `[*]`) is about 60–100 LOC and would drop filter expressions.
- **Verdict: KEEP-WATCH.** Set `eval: false` now. If a new eval-class advisory lands, go in-house with a restricted subset.

### fast-xml-parser
- **Use:** `modules/authentication/cas/authentication.ts`, which parses the CAS `serviceValidate` response (`removeNSPrefix: true`).
- **Health:** NaturalIntelligence org, but amitgupta is the sole publisher (868 commits). 60M downloads/wk, 23 open issues. **44 releases in 12 months.** 12 GHSAs on record, 8 of them in 2026 (including a critical in 2026-02, ≥5.0.0 <5.3.5). Our 5.11.0 is past all of them.
- **Supply chain:** the 5.x line split into six new single-publisher packages: `@nodable/entities`, `fast-xml-builder`, `is-unsafe`, `path-expression-matcher`, `strnum` and `xml-naming`. All have the same sole publisher, amitgupta.
- **Alternatives:** CAS responses are small and well-formed. Options are `@xmldom/xmldom` (not assessed live), or an in-house extractor for `cas:authenticationSuccess/cas:user/cas:attributes` of about 40–60 LOC. Hand-rolled XML is its own risk, though entity expansion isn't needed and can simply be refused.
- **Verdict: KEEP-WATCH.** Churny, one owner across seven packages, and a steady advisory stream, all for a single CAS call site. Revisit if CAS auth is ever reworked, or after another critical advisory.

### tar
- **Use:** `create` in `models/export.ts`, `models/replicationExport.ts` and `modules/storage/disk/storage.ts`. `list` with `onReadEntry` in `models/siteImport.ts`, which reads **untrusted uploaded archives**.
- **Health:** isaacs as sole publisher (710 commits). 62.5M downloads/wk, 13 open issues. 24 releases in 12 months. **12 GHSAs published 2026-01 to 2026-07**, including a critical GHSA-23hp (≤7.5.18) and a high GHSA-r292 (≤7.5.20), a stack-overflow DoS in `list` with member selection. Our 7.5.22 is past all of them.
- **Alternatives:** `tar-stream` 3.2.1 (mafintosh, 73.7M/wk, a lower-level streaming parser with no filesystem extraction logic), or `modern-tar` 0.8.5 (pre-1.0, single maintainer). An in-house ustar writer is about 150 LOC. An in-house reader for our own export format is about 150–200 LOC plus gzip through `node:zlib`, which works because we only ever read archives we wrote.
- **Verdict: KEEP-WATCH.** Healthy and widely used, but the advisory rate is high and the import path takes untrusted input. `tar-stream` is the fallback if the pace of advisories continues. Keep automated patch bumps flowing.

### diff
- **Use:** `models/approvals.ts` (`createPatch`) and `models/pageHistory.ts` (`diffLines`).
- **Health:** kpdecker and ExplodingCabbage. 102M downloads/wk, 9.2k stars, 22 open issues. v9 released 2026-04. One low advisory in 2026, fixed in 8.0.3.
- **Verdict: KEEP.**

### Yjs family: yjs, y-protocols, lib0 (backend) and y-websocket (frontend)
- **Use:**
  - backend: `core/collab.ts` (sync and awareness protocol, lib0 encoding/decoding) and `models/pageDrafts.ts`, 3 source files [5 test]
  - frontend: `composables/collab.js` (`WebsocketProvider`) and `monacoYjsBinding.js`
- **Health:**
  - yjs: 6.45M downloads/wk, 22.8k stars, 138 open issues, lives in the yjs org
  - lib0: 6.6M/wk
  - y-protocols: 3.4M/wk, 1 release in 12 months (fine for a protocol)
  - y-websocket: 0.53M/wk, 38 open issues

  dmonad is the only npm publisher on all four and dominates commits (yjs 2,042; lib0 883), so the bus factor is 1. lib0 is still `0.2.x`, with `1.0.0-rc.32` on `beta`. **yjs 14.0.0-rc.26** (2026-09-07) is imminent. No advisories.
- **Alternatives:** Automerge and Loro exist, but a switch would be a rewrite of the collab stack and stored draft encoding. Not justified.
- **Shakiness:** bus factor 1, and a pre-1.0 lib0 that we import directly. The yjs 14 major will need a coordinated upgrade of all four packages (plus the stored update format, unverified whether that changes).
- **Verdict: KEEP-WATCH.** Plan a v14 upgrade spike. Don't import lib0 more widely than the codec we already use.

### drizzle-orm and drizzle-kit
- **Use:** 63 source files [58 test]. `drizzle-orm` ×119 imports, `/node-postgres` ×9, `/migrator` ×4, `/pg-core` ×6. drizzle-kit is used for `db-generate`.
- **Health:** Drizzle Team (company), 4 publishers. 16.5M downloads/wk, 35.8k stars, **2,022 open issues**. `latest` is still 0.45.2. The `rc` tag is 1.0.0-rc.4 (2026-06-27), `npm view drizzle-orm@1.0.0` returns 404, and only an `rc5` snapshot tag (`1.0.0-rc.5-5935859`) exists. No rc release in 2.5 months, and no GA. SQL-identifier injection GHSA-gpj5 (high) is fixed in 1.0.0-beta.20, so rc.4 is patched.
- **Alternatives:** Kysely (not assessed live). Migration would be enormous. The rc pin was already settled in the prior audit.
- **Verdict: KEEP-WATCH.** Watch for 1.0.0 GA or rc.5. A search result claimed "v1 stable as of March 2026", but npm contradicts it, so that claim is wrong.

### pg and pg-cursor
- **Use:** pg in 9 backend source files (`core/db.ts` Pool, `helpers/pubsub.ts` LISTEN/NOTIFY, `helpers/advisoryLock.ts`, the migration connector) and `e2e/helpers/db.js`. pg-cursor has one use, streaming 2.5.x source rows in `migration/connectors/postgres.ts`.
- **Health:** brianc is the only publisher (1,854 commits; next contributor 79). pg has 39.3M downloads/wk and **527 open issues**. 9 releases in 12 months. Only a 2018 advisory.
- **Alternatives:** `postgres` (porsager) is also single-maintainer (unverified current state). Drizzle supports both, but LISTEN/NOTIFY and advisory-lock code is written against pg's API. Not worth moving.
- **Verdict: pg KEEP-WATCH** (bus factor, issue backlog). **pg-cursor KEEP**: a single contained use in a one-shot importer.

### Group findings
1. **Bump fastify 5.12.1 → ≥5.12.4 now.** Four high GHSAs, published 2026-09-04, affect our pin, including an auth bypass through encapsulated not-found handlers (GHSA-p68q-wchp-6fh7). They weren't yet in the global advisory index when I checked, so `npm audit` can miss them. Bump undici 8.10.0 → 8.10.2 in the same pass, and consider importing `fetch` from undici alongside `Agent` in `liveData.ts`.
2. **Temporal: drop or replace `@js-temporal/polyfill`, and correct CLAUDE.md.**
   - Official Node 26.7.0 and 26.8.1 images ship native `Temporal` (verified). The "undefined on 26.7.0" claim came from a build compiled without Temporal (Homebrew reports `v8_enable_temporal_support=0`).
   - The backend polyfill (stale 0.5.1, last published 2025-03) never loads in CI, the devcontainer or production.
   - Either remove it and fail fast, or switch the fallback to `temporal-polyfill` so all workspaces share one polyfill.
3. **Remove luxon from the tree by replacing cron-parser with croner** (4 backend call sites plus 1 frontend). luxon 3.7.2 is still installed in backend and frontend through cron-parser, and ends up in the `AdminReplication` chunk, despite the project's "luxon removed" policy.
4. **Plan the MCP SDK v2 migration** (`@modelcontextprotocol/server` + `@modelcontextprotocol/fastify`, GA 2026-07-27). It drops express, hono and other unused transitive dependencies, and the v1 line has an unreleased security hardening fix. In the same pass, set `eval: false` on jsonpath-plus.
5. **Reduce single-maintainer lifecycle dependencies where replacements are cheap:**
   - graceful-server → close-with-grace plus our own probe routes (about 100 LOC)
   - poolifier → piscina, on the next scheduler rework
   - nanoid → `node:crypto` (about 15 LOC)
   - filesize → in-house (about 20 LOC)

   Keep exact pins and fixture checks on js-yaml, since 5.4.0 put breaking changes in a minor release.

---

## Group B: auth, storage, search, mail, security and integrations

Audited 2026-09-13 from live data: `npm view`, `gh api` (repos, contributors, advisories), the npm downloads API for the week of 2026-09-05 to 09-11, `npm audit` run in `backend/` and `frontend/`, lockfile versions, and grep over the repo (excluding node_modules, assets and compiled). Anything I could not check live is marked (unverified).

| Package | Workspace(s) | Pinned → Latest | Last publish | Maintainers/backing | Verdict | Risk |
|---|---|---|---|---|---|---|
| @aws-sdk/client-cloudsearch | backend | 3.1116.0 → 3.1131.0 | 2026-09-11 | AWS (org) | CONSIDER-ALTERNATIVE (retire module / OpenSearch) | Med |
| @aws-sdk/client-cloudsearch-domain | backend | 3.1116.0 → 3.1131.0 | 2026-09-11 | AWS (org) | CONSIDER-ALTERNATIVE (same) | Med |
| @aws-sdk/client-s3 | backend | 3.1116.0 → 3.1131.0 | 2026-09-11 | AWS (org) | KEEP | Low |
| @aws-sdk/s3-request-presigner | backend | 3.1116.0 → 3.1131.0 | 2026-09-11 | AWS (org) | KEEP | Low |
| aws-sdk-client-mock (dev) | backend | 4.1.0 = latest | 2024-10-15 | 1 person (m-radzikowski) | KEEP-WATCH (SDK compat, issue #256) | Low |
| s3rver (dev) | backend | 3.7.1 = latest | 2021-10-03 | repo **archived** | REPLACE (MinIO/LocalStack container, or drop) | Low |
| @types/s3rver (dev) | backend | 3.7.4 = latest | 2023-11-21 | DefinitelyTyped | REPLACE (goes with s3rver) | Low |
| @azure/search-documents | backend | 13.0.0 = latest | 2026-05-04 | Microsoft (org) | KEEP | Low |
| @azure/storage-blob | backend | 12.33.0 = latest | 2026-06-24 | Microsoft (org) | KEEP | Low |
| @elastic/elasticsearch | backend | 9.5.0 → 9.5.1 | 2026-08-31 | Elastic (org) | KEEP | Low |
| @google-cloud/storage | backend | 8.0.1 → 8.1.0 | 2026-09-08 | Google (org) | KEEP | Low |
| algoliasearch | backend | 5.57.0 → 5.59.0 | 2026-09-09 | Algolia (org, 19 npm maint) | KEEP | Low |
| @xenova/transformers | backend | 2.17.2 = latest (frozen) | 2024-05-29 | superseded by @huggingface/transformers | **REPLACE** (@huggingface/transformers 4.x) | High |
| @node-saml/node-saml | backend | 5.1.0 = latest | 2025-07-21 | node-saml org, ~1 active (cjbarth) | KEEP-WATCH (maintainer activity, issue #415) | Med |
| openid-client | backend | 6.8.7 → 6.8.8 | 2026-09-05 | 1 person (panva), very responsive | KEEP | Low |
| ldapts | backend | 9.0.0 = latest | 2026-07-11 | ldapts org, 1 human (jgeurts) | KEEP | Low |
| @simplewebauthn/server | backend | 13.3.2 → 14.0.2 | 2026-09-13 | 1 person (MasterKale) | KEEP-WATCH (bus factor; take v14) | Low |
| @simplewebauthn/browser | frontend | 13.3.0 → 14.0.0 | 2026-09-02 | 1 person (MasterKale) | KEEP-WATCH (bump alongside server) | Low |
| bcryptjs | backend | 3.0.3 = latest | 2025-11-02 | 1 person (dcodeIO) | KEEP-WATCH (Node built-in `crypto.argon2`) | Low |
| nodemailer | backend | 9.0.5 → 10.0.9 | 2026-09-12 | nodemailer org, 1 person (andris9) | KEEP-WATCH (**we are on a vulnerable version, bump now**) | High |
| akismet-api | backend | 6.0.0 = latest | 2023-01-28 | 1 person | **REPLACE → remove (no longer imported)** | Low |
| qrcode | backend | 1.5.4 = latest | 2024-08-05 | 2 people, stale | KEEP-WATCH (alt: `uqr`) | Low |
| simple-git | backend | 3.36.0 = latest | 2026-04-12 | 1 person (steveukx) | KEEP-WATCH (RCE-class advisory history) | Med |
| ssh2-sftp-client | backend | 12.1.1 = latest | 2026-03-25 | 1 person (theophilusx) | KEEP-WATCH | Low |
| ssh2 (dev, runtime via sftp client) | backend | 1.17.0 = latest | 2025-08-20 | 1 person (mscdex) | KEEP-WATCH (bus factor, install script) | Med |
| sanitize-html | backend | 2.17.7 = latest | 2026-08-13 | ApostropheCMS (org) | KEEP-WATCH (5 advisories in 2026) | Med |
| cheerio | backend | 1.2.0 = latest | 2026-01-23 | cheeriojs org | KEEP | Low |
| @iconify/utils | backend | 3.1.4 → 3.1.7 | 2026-09-06 | iconify org, 1 person (cyberalien) | KEEP | Low |
| iconify-icon | frontend | 3.0.2 = latest | 2025-10-25 | iconify org, 1 person | KEEP | Low |
| @iconify-json/tabler (dev) | backend, frontend | 1.2.38 = latest | 2026-07-28 | iconify org | KEEP | Low |
| @iconify-json/la (dev) | frontend | 1.2.1 = latest | 2024-12-16 | iconify org (upstream set frozen) | KEEP | Low |
| @iconify-json/mdi (dev) | frontend | 1.2.3 = latest | 2025-01-20 | iconify org (upstream set frozen) | KEEP | Low |
| @zxcvbn-ts/core | frontend | 4.2.0 = latest | 2026-08-12 | zxcvbn-ts org, 1 person (MrWook) | KEEP | Low |
| @zxcvbn-ts/language-common | frontend | 4.1.3 = latest | 2026-07-16 | same | KEEP | Low |
| @zxcvbn-ts/language-en | frontend | 4.1.1 = latest | 2026-06-16 | same | KEEP | Low |
| vue3-otp-input | frontend | 0.5.40 = latest | 2025-05-29 | 1 person (ejirocodes), pre-1.0 | IN-HOUSE-CANDIDATE | Low |

### @aws-sdk/client-cloudsearch, @aws-sdk/client-cloudsearch-domain
- **Use:** only `backend/modules/search/aws-cloudsearch/search.ts` (1175 LOC, plus 1101 LOC of tests). It uses 9 commands: Define/Describe for AnalysisScheme, IndexField and Suggester, plus IndexDocuments, Search and UploadDocuments.
- **Health:** the libraries are fine. AWS publishes from its SDK monorepo, 212 releases in the last 12 months (a daily cadence), not archived. Downloads: 23.5k/wk (control plane) and 32.7k/wk (domain). No advisories.
- **The product is the problem.** Amazon CloudSearch has been closed to new customers since **2024-07-25**. Existing customers can keep using it and AWS says it will keep up security and availability, but plans no new features. AWS points people to Amazon OpenSearch Service instead. No end-of-support date has been announced. Sources: [InfoWorld](https://www.infoworld.com/article/3484870/aws-closes-several-cloud-services-to-new-customers.html), [Neowin](https://www.neowin.net/news/aws-to-discontinue-cloud9-codecommit-cloudsearch-and-several-other-services/), [AWS docs](https://docs.aws.amazon.com/cloudsearch/latest/developerguide/what-is-cloudsearch.html).
  - Cardinal.js 3.x has not shipped, so anyone configuring this module would need an AWS account old enough to still be allowed CloudSearch domains. In practice that audience is close to nobody.
- **Alternatives:**
  - Retire the module.
  - Or add an OpenSearch engine on `@opensearch-project/opensearch`, extending `ExternalSearchModule`. The existing `elasticsearch` module may not work against OpenSearch, because the 8.x/9.x Elastic clients do a product check (unverified for 9.5).
  - Cost: deleting is about −2.3k LOC plus a `definition.yml`. A new OpenSearch engine would be about 450 LOC, based on the size of the ES module.
- **Shakiness:** none in the code, but it is effectively a dead end: roughly 2.3k LOC that must keep passing tests for an unreachable user base.
- **Verdict: CONSIDER-ALTERNATIVE.** Retire the CloudSearch module, keep a migration note for old configs, and add OpenSearch if anyone asks for it.

### @aws-sdk/client-s3, @aws-sdk/s3-request-presigner
- **Use:** `modules/storage/s3/storage.ts` (211 LOC, one of the `blobBase.ts` drivers) plus 3 test files.
- **Health:** AWS org, daily releases. 32.9M/wk (client-s3) and 16.2M/wk (presigner). No advisories for client-s3. Our pin is 15 releases behind, which is normal drift at this cadence.
- **Alternatives:** a leaner S3 client such as `aws4fetch` (unverified) would lose multipart and checksum handling. Not worth it.
- **Verdict: KEEP.** The reference implementation, backed by AWS, and the only cost is keeping up with version bumps.

### aws-sdk-client-mock (dev)
- **Use:** `modules/storage/s3/storage.test.ts` (`mockClient(S3Client)`).
- **Health:**
  - Last publish 2024-10-15, so nothing in about 23 months. One maintainer (128 commits). 911 stars, 32 open issues, 2.3M/wk.
  - Open issue #256 (2025-10-29) is titled "Does not work with the latest version of AWS sdk". #253 says sinon should be a peer dependency.
  - It pulls in `sinon` 18 as a hard dependency.
- **Alternatives:** `aws-sdk-client-mock-vitest` is a matcher add-on, not a replacement. Or stub `S3Client.prototype.send` with `node:test`'s `mock.method`, which is about 30 LOC and fits the repo's no-framework test style.
- **Shakiness:** stale, but dev-only and our suite currently works with it (unverified that it passes at 3.1131).
- **Verdict: KEEP-WATCH.** If an SDK bump breaks it, swap to `mock.method` rather than looking for another library.

### s3rver, @types/s3rver (dev)
- **Use:** `modules/storage/s3/storage.emulated.test.ts` (219 LOC), an in-process fake S3.
- **Health:**
  - The GitHub repo is **archived** (last push 2025-08-10). Last npm publish was 2021-10-03; types were last published 2023-11.
  - `npm audit` marks `s3rver` itself as **high**, through `busboy` 0.3.1 → `dicer` (GHSA-wm7h-9275-46v2, no fix) and a nested `fast-xml-parser` 3.21.1 (moderate). The only "fix" npm offers is a downgrade to 2.2.9.
  - It pulls in `koa` 2.
- **Alternatives:** MinIO or LocalStack through `@testcontainers/minio` / `@testcontainers/localstack` (12.1.0, published 2026-08-04). CI already runs service containers. Or run a `minio` service in `quality.yml`. Cost: rewrite one 219-LOC test and gate it behind an env var the way `hasTestDatabase()` gates DB tests.
- **Shakiness:** abandoned, and it keeps a permanent high-severity finding in `backend` `npm audit`. That conflicts with the zero-warnings rule even though it is dev-only.
- **Verdict: REPLACE.** Archived, with no fix available.

### @azure/search-documents, @azure/storage-blob
- **Use:** `modules/search/azure-search/search.ts` (784 LOC) and `modules/storage/azure/storage.ts` (103 LOC).
- **Health:** Microsoft's azure-sdk-for-js monorepo, active (pushed 2026-09-13). 330k/wk (search) and 7.0M/wk (blob). Both pinned at latest. No advisories. storage-blob now requires Node ≥22, which is fine for us.
- **Verdict: KEEP.** Official SDKs, current, no advisories.

### @elastic/elasticsearch
- **Use:** `modules/search/elasticsearch/search.ts` (459 LOC) plus a smoke test.
- **Health:** Elastic org, 75 releases in 12 months, 21 open issues, 1.85M/wk, no advisories. 9.5.1 is a patch release ahead of us.
- **Verdict: KEEP.** Official client, active, no advisories.

### @google-cloud/storage
- **Use:** `modules/storage/gcs/storage.ts` (104 LOC).
- **Health:** Google org (google-cloud-node monorepo), 12.7M/wk. 8.1.0 published 2026-09-08. `npm audit` shows a moderate advisory on transitive `gaxios` 6.4–6.7.1 via `uuid` <11.1.1 (GHSA-w5hq-g745-h8pq, fixable). I have not confirmed which package pulls in that `gaxios` (unverified).
- **Verdict: KEEP.** Bump to 8.1.0 and re-run the audit.

### algoliasearch
- **Use:** `modules/search/algolia/search.ts` (470 LOC).
- **Health:** Algolia org, 39 releases in 12 months, 24 open issues, 5.6M/wk, no advisories.
- **Verdict: KEEP.**

### @xenova/transformers
- **Use:**
  - Only through `helpers/embeddings.ts` (137 LOC): a lazy dynamic `import(specifier)` and `pipeline('feature-extraction', MODEL_NAME)`, feeding semantic search.
  - Two test files (`helpers/embeddings.test.ts`, `models/semanticSearch.test.ts`) rename `node_modules/@xenova/transformers` on disk to simulate the package being absent.
- **Health:**
  - **Frozen.** Last publish 2024-05-29, and no releases since. The project moved to the Hugging Face org and republished as `@huggingface/transformers` starting with v3 ([HF v3 blog](https://huggingface.co/blog/transformersjs-v3), [issue #1291](https://github.com/huggingface/transformers.js/issues/1291)). The successor is at 4.2.0 (2026-04-22), has 21 releases in 12 months, 5 npm maintainers, 2.07M/wk, versus 372k/wk for the old name.
  - `npm audit` (backend) traces most of the tree's worst findings to this one package:
    - **critical** `protobufjs` ≤7.6.2 (6.11.6 installed, 11 GHSAs)
    - high `onnxruntime-web` 1.14.0
    - high `onnx-proto`
    - high `sharp` 0.32.6, installed **nested** with an install script
  - The only "fix" npm offers is a downgrade to 1.4.2.
- **Alternatives:** `@huggingface/transformers` 4.2.0, which uses `onnxruntime-node` 1.24.3 and `sharp` ^0.34.5.
  - The v4 blog says legacy `Xenova/*` ONNX models are still compatible ([HF v4 blog](https://huggingface.co/blog/transformersjs-v4)). I have not confirmed our exact model id loads unchanged (unverified).
  - Migration: change the specifier string and the two test paths, then check that the output vector shape and dimensions match, since stored pgvector embeddings depend on that. Roughly 0.5–1 day, plus a re-embed only if vectors differ.
  - Caveat: `sharp` ^0.34.5 is still inside the current sharp advisory range (≤0.35.4-rc.0; 0.35.4 is the fix). The top-level `sharp` is 0.35.3 and needs a bump anyway (outside this group).
- **Shakiness:** abandoned package name carrying a critical transitive advisory and a native install script in a production dependency.
- **Verdict: REPLACE.** A clear successor exists under the same author at Hugging Face, and the work is contained to one 137-LOC seam.

### @node-saml/node-saml
- **Use:** `modules/authentication/saml/authentication.ts` (308 LOC): `new SAML({...})`, `validatePostResponseAsync`, with `wantAssertionsSigned` defaulting to true.
- **Health:**
  - 5.1.0 (2025-07-21) fixed two **critical** 2025 advisories: GHSA-4mxg-3p6v-xgq3 (signature verification) and GHSA-m837-g268-mmv7 (auth bypass). We are on the patched version. Transitive `xml-crypto` is 6.1.2, patched for 2025's SAMLStorm class. `@xmldom/xmldom` 0.8.15 is patched for the 2026-09-08 batch of xmldom advisories.
  - **The worry is the maintainers.** No npm publish in about 14 months. Last commit to the default branch was 2025-09-11. PR #414 (move to xmldom 0.9.x) has been open since 2026-06-17. **Issue #415 "Vulnerability submission inquiry" was opened 2026-09-09 and is still open**, which suggests someone may be trying to report a new vulnerability.
  - Top contributors: ploer (153 commits, historical), cjbarth (136), who is also the main `xml-crypto` maintainer. So the whole SAML stack effectively rests on one person.
  - 775k/wk downloads, 31 open issues.
- **Alternatives:**
  - `samlify` 2.13.1: 1 npm maintainer, a critical advisory 2025-05 and a high one 2026-05. Not better.
  - `@boxyhq/saml20` 1.18.0 (2026-09-07, 2 maintainers, no GHSA found): active, but its security track record is less proven (unverified).
  - **In-house is clearly worse.** XML signature canonicalization and wrapping attacks are exactly what sank several libraries in 2025, and a home-grown version would repeat those mistakes without the audit history.
- **Verdict: KEEP-WATCH.** Watch issue #415 and xmldom advisories weekly. If #415 turns into an advisory with no release within about 30 days, evaluate `@boxyhq/saml20`.

### openid-client
- **Use:** `modules/authentication/oidc/authentication.ts` (214 LOC) and `google/authentication.ts` (120 LOC), via `import * as client`.
- **Health:**
  - One maintainer (panva: 1113 commits; next contributor has 4). The same person maintains its dependencies `oauth4webapi` 3.8.7 and `jose` 6.2.10.
  - **0 open issues**, 8 releases in 12 months, 9.8M/wk, no advisories.
  - Bus factor is 1, but this is the most carefully maintained OAuth/OIDC stack on npm, and openid-client is OpenID Foundation certified (unverified).
- **Alternatives:** none better. In-house OIDC is a security regression.
- **Verdict: KEEP.** Bump to 6.8.8.

### ldapts
- **Use:** `modules/authentication/ldap/authentication.ts` (335 LOC), using `Client`. This replaced ldapjs in 2026-08.
- **Health:** ldapts org, but jgeurts is the only human committer (263 commits; the rest is renovate). 38 releases in 12 months, 3 open issues, 352k/wk, no advisories. The 9.0.0 major landed the same day as 8.2.0 (2026-07-11), so majors do happen.
- **Alternatives:** none. ldapjs is decommissioned.
- **Verdict: KEEP.** Responsive and low backlog; the bus factor is acceptable for an optional auth module.

### @simplewebauthn/server, @simplewebauthn/browser
- **Use:** server side in `models/passkeys.ts` (476 LOC). Browser side in `AuthLoginPanel.vue` and `ProfileAuth.vue`.
- **Health:**
  - One maintainer (MasterKale: 2445 commits; next contributor has 24). 5 open issues. 3.2M/wk (server), 3.6M/wk (browser).
  - The only advisory, GHSA-6hxq-p678-4hr2 (low, 2026-09-04, attestation certificate checks), was fixed in 13.3.2, which is what we pin.
  - v14.0.0 (2026-09-02) adds ML-DSA post-quantum support and Signal APIs. Its breaking change is a minimum of Node 22 LTS, which is harmless for us.
- **Alternatives:** none comparable. In-house WebAuthn (CBOR/COSE, attestation formats) is **worse**.
- **Verdict: KEEP-WATCH.** Keep an eye on the bus factor, and upgrade server and browser to v14 together.

### bcryptjs
- **Use:** 16 hash/compare call sites across `models/login.ts`, `models/userCredentials.ts`, `models/users.ts` and `models/pages.ts` (page passwords), `modules/authentication/local` (a constant-time dummy hash) and the 2.5.x importer. Plus 3 test files. Cost factor comes from `BCRYPT_ROUNDS`.
- **Health:** one maintainer (dcodeIO, 96 of about 105 commits). 3.0.3 (2025-11) is its only release in 12 months. 6 open issues, 10.1M/wk, no advisories. It is a mature, small, pure-JS implementation.
- **Alternatives:**
  - **Node 26 has a built-in `crypto.argon2`.** I confirmed on the local Node v26.8.1 that `typeof crypto.argon2 === 'function'` and that an argon2id hash (m=19456, t=2, p=1) runs. Its stability level is unconfirmed (unverified: added in 24.7 as experimental).
  - `argon2` (1.7M/wk, native install script) and `@node-rs/argon2` (937k/wk, 1 maintainer) are the npm options.
  - Migration: add hash-format detection (`$2` prefix versus `$argon2id$`) and rehash on the next successful login. Page passwords and recovery codes only move when they are next used. About 1–2 days including tests.
  - Pure-JS bcrypt also blocks the event loop more than native code, and bcrypt truncates passwords at 72 bytes (unverified that no length guard already exists).
- **Shakiness:** single maintainer, but a finished algorithm with a tiny surface. An in-house bcrypt would be worse, and the built-in is the in-house-free route.
- **Verdict: KEEP-WATCH.** Once `crypto.argon2` is marked stable in Node 26 LTS, move to built-in argon2id with rehash-on-login and drop the dependency.

### nodemailer
- **Use:** `models/mail.ts` (1063 LOC), one `createTransport` site.
- **Health:**
  - nodemailer org, but one human (andris9: 823 commits; next contributor has 7). 17.5M/wk. 37 releases in 12 months, including 4 on 2026-09-11/12 alone.
  - 12 advisories in the last 12 months, among them SMTP command injection, CRLF header injection, a TLS validation flaw and a sandbox bypass.
  - **Our pin 9.0.5 is vulnerable** to GHSA-2x7j-588g-ccc2 (**high**, quadratic addressparser DoS), GHSA-wmmp-3585-3rmp, GHSA-cc9r-2j5m-2m83 (recipient-domain allow-list bypasses) and GHSA-8m3c-c648-2xjj. `npm audit` confirms (high; minor-version fix to 9.1.1).
  - Latest 10.0.9: the v10 break is Node ≥20 plus a TypeScript/ESM rewrite, so migration cost for us is trivial. `@types/nodemailer` may become unnecessary (unverified).
- **Alternatives:** none with comparable reach. An HTTP provider SDK would lose generic SMTP.
- **Shakiness:** very active but churny, with frequent security fixes and one person behind it. Rewriting SMTP and MIME in-house would be far worse.
- **Verdict: KEEP-WATCH.** **Bump now** (at least 9.1.1, ideally 10.0.9), and treat nodemailer as a package that needs a fast patch cadence.

### akismet-api
- **Use:** **none.** No import anywhere. `modules/comments/default/comments.ts` now calls Akismet's REST API directly through `fetch` (`https://rest.akismet.com/1.1/verify-key`, plus a `User-Agent` header), and its doc comments (lines 270, 289) say the field aliases were copied from `akismet-api`'s source. The package is still listed in `backend/package.json:79`.
  - This contradicts the 2026-08-22 audit's note that akismet-api was live in `comments.ts`. The code has changed since then.
- **Health:** last publish 2023-01-28, last repo push 2024-03-30, one maintainer, 12k/wk.
- **Verdict: REPLACE → remove from `package.json`.** It is dead weight; the in-house `fetch` client already replaced it.

### qrcode
- **Use:** one call, `QRCode.toString(buildTotpUri(...))` in `models/userCredentials.ts:548` (TOTP setup image).
- **Health:** last publish 2024-08-05 (about 2 years), last repo push 2024-08-23. **125 open issues**. Two maintainers, 19.1M/wk, no advisories.
- **Alternatives:** `uqr` (unjs, 0.1.3 published 2026-04, 2 maintainers, 3.2M/wk) has no dependencies and outputs SVG (unverified API parity). `qrcode-generator` 2.0.4 has 1 maintainer.
- **In-house:** a QR encoder (Reed–Solomon, masking, version tables) is about 800–1000 LOC to get right. Not worth it for one call.
- **Verdict: KEEP-WATCH.** Stale but stable, and it only ever sees server-generated input. Swap to `uqr` only if it breaks.

### simple-git
- **Use:** `modules/storage/git/` (repo, sync, content, actions, plus tests): about 12 distinct commands (commit ×14, add ×10, raw ×7, pull, addConfig, log, getRemotes, checkIgnore, rm, mv, branch).
- **Health:**
  - One maintainer (steveukx: 1205 commits). 80 open issues, 8.2M/wk.
  - **A long history of RCE / command-injection advisories:** 2022 ×3, 2023 critical, and **three in 2026** (critical GHSA-r275-fr43-pm7q 03-10; high GHSA-jcxm-m3jx-f287 04-13; high GHSA-hffm-xvc3-vprc 04-25).
  - 3.36.0 (our pin, which is latest) fixes all of them. No release since 2026-04-12.
- **Alternatives:**
  - `isomorphic-git`: pure JS, but slower and with fewer protocols (unverified).
  - An in-house `execFile('git', [...])` wrapper, about 250–400 LOC. We already control every argv; the injection bugs live in simple-git's option parsing, which is what a wrapper would remove.
- **Shakiness:** a single maintainer, and the dangerous class of bug keeps recurring.
- **Verdict: KEEP-WATCH.** If another RCE-class advisory lands, promote to IN-HOUSE-CANDIDATE: a thin `execFile` wrapper with fixed argv and `--` separators is contained and removes the parsing surface.

### ssh2-sftp-client, ssh2
- **Use:**
  - `ssh2-sftp-client`: `modules/storage/sftp/` (connection, pages, assets, plus tests).
  - `ssh2`: listed as a dev dependency for `test/sftpServer.ts`, but `ssh2-sftp-client` also depends on it at runtime, so it ships in production.
- **Health:**
  - ssh2-sftp-client: one maintainer (theophilusx: 717 commits), 1 open issue, 1.9M/wk, 2 releases in 12 months, no advisories.
  - ssh2: one maintainer (mscdex: 1041 commits; next contributor has 4). 106 open issues, 8.7M/wk. Last publish 2025-08-20. It has an **install script** (`node install.js`), which builds the optional native `cpu-features` addon (0.0.10, which also has an install script). The only advisory is from 2021 (fixed in 1.4.0).
- **Alternatives:** no maintained pure-JS SSH alternative of similar reach (unverified). The client wrapper could be replaced by promisifying ssh2's own `sftp` subsystem (about 150–250 LOC), but that does not remove the ssh2 bus-factor risk. An in-house SSH protocol implementation is out of the question.
- **Verdict: KEEP-WATCH** for both. The SSH transport rests on one person and there is no better option. Consider `npm config ignore-scripts` / skipping `cpu-features` in the Docker build (unverified effect).

### sanitize-html
- **Use:** 9 non-test call sites across `models/rendering.ts`, `helpers/htmlSanitizePolicy.ts` (the shared policy), `helpers/images.ts` and `modules/comments/default/comments.ts`. It is the core defence against stored XSS in page content.
- **Health:**
  - Maintained by ApostropheCMS: 4 npm maintainers, 7.6M/wk. The standalone repo `apostrophecms/sanitize-html` is **archived**, and development has moved into the `apostrophecms/apostrophe` monorepo (npm `repository` now points there; that repo was active 2026-09-11).
  - **Five advisories in 2026:** GHSA-9mrh (04), GHSA-rpr9 **critical** (05, default XSS via `xmp` in 2.17.3), GHSA-vccv (07, `javascript:` URIs), GHSA-g8qq (09-01, SVG SMIL), GHSA-jxwj (09-03, mutation XSS). Each was fixed within days, and 2.17.7 (our pin) is patched for all of them.
- **Alternatives:** `DOMPurify` (cure53, the standard bearer; 3.4.15) needs a server-side DOM (`jsdom`, or `isomorphic-dompurify`, whose npm package has 1 maintainer and is at 4.2.0). DOMPurify has its own recent advisories too (frontend audit shows four ≤3.4.12). Migrating would mean rewriting the allow-list policy in `htmlSanitizePolicy.ts` and re-proving it with the test suite, which is substantial.
- **Shakiness:** the bug rate is high, but so is the fix rate, and it has org backing. **An in-house sanitizer would be strictly worse.**
- **Verdict: KEEP-WATCH.** Subscribe to GHSA for sanitize-html, keep the exact pin, and bump within days of each advisory. Re-evaluate DOMPurify+jsdom only if response times slip.

### cheerio
- **Use:** `models/rendering.ts` (load, stripEditorArtifacts, liftIconChildren, inlineIcons), `helpers/htmlSanitizePolicy.ts`, and `migration/mappers/drawioFence.ts` (XML mode).
- **Health:** cheeriojs org (fb55 and others), 57 open issues, 19.7M/wk, no advisories. Only one release in 12 months (1.2.0, 2026-01), but the repo is active (2026-09-11).
- **Verdict: KEEP.** Mature and widely used, no advisories.

### @iconify/utils, iconify-icon
- **Use:** `@iconify/utils` in `models/icons.ts` (getIconData, iconToSVG, iconToHTML, replaceIDs) and `models/rendering.ts` (flip and rotate helpers). `iconify-icon` in `frontend/src/boot/iconify.js`, as the fallback path for user-picked icons.
- **Health:** iconify org, but effectively one person (cyberalien: 1184 commits; next contributor has 100). 24 open issues. `@iconify/utils` gets 13.0M/wk, with 10 releases in 12 months (3.1.7 published 2026-09-06). `iconify-icon` gets 85.5k/wk (3.0.2, 2025-10). No advisories.
- **Verdict: KEEP** both. Bump `@iconify/utils` to 3.1.7. The format is ours to vendor if the project ever stalls.

### @iconify-json/tabler, @iconify-json/la, @iconify-json/mdi (dev)
- **Use:** build-time only. `backend/scripts/vendor-icon-sets.ts` vendors tabler into `assets/icon-sets/tabler.json`. `frontend/scripts/generate-icons.mjs:434` reads `node_modules/@iconify-json/<prefix>/icons.json` to build the committed `icons.generated.js`.
- **Health:** all pinned at latest. tabler is active (16 releases in 12 months). `la` and `mdi` have not moved because their upstreams are frozen: npm `line-awesome` was last modified 2022-05-08, `@mdi/svg` 7.4.47 was last modified 2023-12-27. Downloads: 132k (tabler), 4.7k (la), 243k (mdi) per week.
- **Verdict: KEEP.** These are JSON data packages used only at build time and gated by the `icons:check` drift checks. A frozen upstream is harmless here.

### @zxcvbn-ts/core, @zxcvbn-ts/language-common, @zxcvbn-ts/language-en
- **Use:** `frontend/src/helpers/passwordStrength.js` only.
- **Health:** zxcvbn-ts org, one active maintainer (MrWook: 451 commits). 8 open issues, about 1.06M/wk (core), active (4.2.0 published 2026-08-12). No advisories.
- **Verdict: KEEP.** This is advisory UI, not a security boundary.

### vue3-otp-input
- **Use:** 3 `<v-otp-input>` instances in `components/AuthTfaScreens.vue` (×2) and `components/SetupTfaDialog.vue`, plus `SetupTfaDialog.test.js`. It is already restyled through `.otp-input` in `css/tailwind.css`.
- **Health:** one maintainer (ejirocodes: 132 commits), pre-1.0 (0.5.40), last publish 2025-05-29, last push 2025-10-06. 124 stars, 20k/wk. It lists `vue ^3.4.27` under `dependencies` as well as `peerDependencies`, which could duplicate Vue if the ranges diverge (unverified).
- **Alternatives:** `vue-otp-input` 1.0.0 is dead (2022).
- **In-house:** a `WOtpInput.vue` for the shared `W*` library (N inputs, paste split, backspace navigation, `inputmode="numeric"`, `autocomplete="one-time-code"`) is about 120–180 LOC plus a Vitest suite. It is not security logic, since the server verifies the code.
- **Verdict: IN-HOUSE-CANDIDATE.** Small, UI-only, and a shaky pre-1.0 single-maintainer package in the login path. It would also match the W* component-library convention.

### Group findings
1. **Bump nodemailer now** (9.0.5 → 9.1.1 minimum, 10.0.9 preferred). Our pin is inside four current advisories, including a high-severity remote DoS in address parsing (GHSA-2x7j-588g-ccc2). It is a one-line change and v10's only break is Node ≥20.
2. **Replace `@xenova/transformers` with `@huggingface/transformers` 4.x.** The old name has been frozen since 2024-05, and it accounts for the backend's only **critical** `npm audit` finding (protobufjs) plus 3 high ones and a nested native sharp 0.32.6. The work is contained to `helpers/embeddings.ts` (137 LOC) and two test paths. Verify the embedding dimensions and model id before merging.
3. **Remove the dead `akismet-api` dependency** (no import; `comments.ts` now calls the REST API directly). Also **replace `s3rver`** (archived, high audit finding with no fix) with a MinIO/LocalStack container test, or drop that one emulated test. Together these clear the remaining dev-only audit noise in this group.
4. **Decide the future of the AWS CloudSearch module.** AWS closed CloudSearch to new customers on 2024-07-25 and plans no new features. Retiring it removes about 2.3k LOC (module and tests) that nobody new can use. Offer OpenSearch instead if there is demand.
5. **Watch the SAML stack closely.** `@node-saml/node-saml` has had no release in 14 months, one active maintainer, and an open "Vulnerability submission inquiry" (#415, 2026-09-09). It stays the right choice (samlify is worse, and in-house is out of the question), but plan to evaluate `@boxyhq/saml20` if #415 becomes an unpatched advisory. Separately, `vue3-otp-input` is the one package here small enough and shaky enough to own as a `W*` component (about 150 LOC).

---

## C. Frontend app and editor dependencies

Audited 2026-09-13 against live data: `npm view` (versions, publish times, maintainers), the npm downloads API (last week = 2026-09-05..09-11), `gh api` (repo health, contributors, `/advisories`), `npm audit --omit=dev` and `npm ls` run in `frontend/` (read-only), and a grep of `frontend/src`, `frontend/scripts` and `vite.config.js`. "Use sites" counts **non-test source files** importing the package; test-file counts are given where relevant. "Last publish" is the publish date of the current `latest` dist-tag.

| Package | Workspace(s) | Pinned → Latest | Last publish | Maintainers/backing | Verdict | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| vue | frontend | 3.5.41 → 3.5.42 | 2026-08-27 | vuejs org (yyx990803, posva) | KEEP | Low |
| vue-router | frontend | 5.2.0 → 5.3.1 | 2026-09-02 | vuejs org (posva) | KEEP | Low |
| pinia | frontend | 4.0.3 → 4.0.3 | 2026-08-12 | vuejs org (posva) | KEEP | Low |
| vue-i18n | frontend | 11.4.9 → 11.4.10 | 2026-08-25 | intlify org (kazupon) | KEEP-WATCH | Low |
| @tiptap/starter-kit, @tiptap/vue-3, @tiptap/suggestion | frontend | 3.30.2 → 3.31.3 | 2026-09-04 | ueberdosis GmbH (6 npm maintainers) | KEEP-WATCH (**patch now**) | Med |
| @tiptap/extension-* (19 packages) | frontend | 3.30.2 → 3.31.3 | 2026-09-04 | ueberdosis GmbH | KEEP-WATCH (**patch now**) | Med |
| monaco-editor | frontend | 0.56.0 → 0.56.0 | 2026-07-20 | Microsoft | KEEP-WATCH | Med |
| lowlight | frontend | 3.3.0 → 3.3.0 | 2024-12-14 | wooorm (solo) | KEEP | Low |
| ky | frontend | 2.0.2 → 2.1.0 | 2026-08-28 | sindresorhus (solo) | KEEP | Low |
| mitt | frontend | 3.0.1 → 3.0.1 | 2023-07-04 | developit (solo) | KEEP | Low |
| uuid | frontend | 14.0.2 → 14.0.2 | 2026-08-18 | uuidjs org (broofa, ctavan) | KEEP | Low |
| fuse.js | frontend | 7.5.0 → 7.5.0 | 2026-07-13 | krisk (solo) | KEEP | Low |
| sortablejs | frontend | 1.15.7 → 1.15.7 | 2026-02-11 | SortableJS org (2) | KEEP-WATCH | Low |
| sortablejs-vue3 | frontend | 1.3.0 → 1.3.0 | 2025-08-20 | maxleiter (solo) | IN-HOUSE-CANDIDATE | Low |
| browser-fs-access | frontend | 0.38.0 → 0.38.0 | 2025-06-18 | GoogleChromeLabs (tomayac, effectively solo) | KEEP-WATCH | Low |
| d3-force | frontend | 3.0.0 → 3.0.0 | 2021-06-05 | d3 org (mbostock, Fil) | KEEP | Low |
| d3-quadtree | frontend | 3.0.1 → 3.0.1 | 2021-06-05 | d3 org | KEEP | Low |
| d3-selection | frontend | 3.0.0 → 3.0.0 | 2021-06-07 | d3 org | KEEP | Low |
| d3-zoom | frontend | 3.0.0 → 3.0.0 | 2021-06-10 | d3 org | KEEP | Low |
| slugify | frontend | 1.6.9 → 1.6.9 | 2026-04-01 | simov + Trott + JoshuaKGoldberg | KEEP | Low |
| text-case | frontend | 1.2.11 → 1.2.11 | 2026-05-19 | idimetrix (solo, 17 stars) | IN-HOUSE-CANDIDATE | Med |
| turndown | frontend | 7.2.4 → 7.2.4 | 2026-04-03 | mixmark-io org (2) | KEEP | Low |
| turndown-plugin-gfm | frontend | 1.0.2 → 1.0.2 | 2018-05-11 | domchristie (solo, dormant) | REPLACE (`@joplin/turndown-plugin-gfm`) | Med |
| @twemoji/api | frontend | 17.0.2 → 17.0.3 (deliberate lag) | 2026-06-01 | jdecked community fork (2 npm) | KEEP-WATCH | Med |
| twemoji-assets (GitHub tarball) | frontend | tag v17.0.3 | 2026-06-01 (tag) | jdecked/twemoji | KEEP-WATCH | Med |
| unicode-emoji-json (dev) | frontend | 0.9.0 → 0.9.0 | 2026-04-18 | muan (solo) | KEEP | Low |
| tailwindcss | frontend | 4.3.3 → 4.3.3 | 2026-07-16 | Tailwind Labs | KEEP | Low |
| @tailwindcss/vite | frontend | 4.3.3 → 4.3.3 | 2026-07-16 | Tailwind Labs | KEEP | Low |

### vue

- **Use:** the app framework. 234 src files, 32 test files.
- **Health:** 21 stable releases in the last 12 months. 11.28M downloads/wk. vuejs/core is not archived, last push 2026-09-14, 923 open issues, 54k stars. After Evan You (3576 commits), edison1105 (362) and sxzz (110) are the most active contributors. The only advisory, GHSA-5j4c-8p2g-v4jx, affects Vue 2 only. 3.6.0 is at `rc.8` (Vapor mode); the rc tag is live, but "Vapor mode" as its headline feature is (unverified).
- **Alternatives:** none worth considering. The whole app is built on it.
- **Shakiness:** none.
- **Verdict: KEEP.** Take the 3.5.42 patch. Plan a 3.6 check when it goes GA.

### vue-router

- **Use:** routing. 36 src files.
- **Health:** 17 stable releases in 12 months, 5.3.1 published 2026-09-02. 6.07M downloads/wk. 53 open issues. posva wrote 2284 commits, so the bus factor is concentrated, but the package sits in the vuejs org. No advisories.
- **Alternatives:** none.
- **Shakiness:** low. The project is posva-centric, but under the org.
- **Verdict: KEEP.** Bump to 5.3.1.

### pinia

- **Use:** all stores. 12 src files, 104 test files.
- **Health:** at latest (4.0.3, 2026-08-12). 3.54M downloads/wk, 24 open issues. posva is the only npm maintainer, under the vuejs org. No advisories.
- **Alternatives:** none. It is Vue's official store.
- **Shakiness:** single npm publisher, mitigated by org ownership.
- **Verdict: KEEP.**

### vue-i18n

- **Use:** every translated string. 171 src files. Configured `legacy: false` in `src/boot/i18n.js`.
- **Health:** 19 stable releases in 12 months, 2.69M downloads/wk, 94 open issues. kazupon wrote 2470 commits and is the sole npm maintainer, under the intlify org.
  - **Advisories:** four between 2024-12 and 2025-07 (prototype pollution and XSS). All are fixed at or below 11.1.10, so none affects 11.4.9.
- **Alternatives:** none that are mainstream for Vue.
- **Shakiness:** `next` = 12.0.0-alpha.4. v12 removes Legacy API mode, `v-t` and `$tc`, per the intlify migration docs found by search (unverified in detail).
  - A grep found no `v-t=`, `$tc(`, `tc(` or `legacy: true`, so we look ready.
  - 3 `.vue` files still use template `$t(`. Whether v12 also drops global `$t` is (unverified).
  - Recurring prototype-pollution advisories justify keeping it patched.
- **Verdict: KEEP-WATCH.** Re-check the three `$t` templates against the v12 migration guide when v12 leaves alpha. Take 11.4.10.

### @tiptap/* (starter-kit, vue-3, suggestion and 19 extensions)

- **Use:** the WYSIWYG editor. Imported in 3 src files: `components/EditorWysiwyg.vue`, `composables/collab.js`, `helpers/editorMentions.js`.
  - Every declared extension is imported. Most have exactly one import site; color, highlight, table and text-style have two, collaboration has three.
  - Collaboration runs through self-hosted Yjs and y-websocket, not Tiptap Cloud.
  - **Undeclared imports:** `EditorWysiwyg.collab.test.js` imports `@tiptap/core` and `@tiptap/y-tiptap`, neither of which is in `package.json`. Both resolve only as transitive dependencies.
- **Health:** tiptap is an ueberdosis company repo: not archived, last push 2026-09-08, 846 open issues, 38k stars. Top committers are philippkuehn, hanspagel and bdbch, with 6 npm maintainers. `@tiptap/core` gets 13.9M downloads/wk and `@tiptap/vue-3` 1.18M/wk. Release cadence is very high: **96 stable `@tiptap/core` releases in 12 months** (3.31.0 to 3.31.3 all shipped 2026-09-01..04).
- **Advisories affecting our pin (3.30.2):**
  - **GHSA-cp6q-959q-f8rh** (medium, 2026-09-02). `mergeAttributes()` lets a `__proto__` key from JSON become inherited DOM attributes such as `onerror`, which is XSS. Affects `@tiptap/core` < 3.30.4. This is plausibly reachable, because collaborative content arrives from other peers.
  - **GHSA-j95f-988m-3j2f** (high, 2026-09-08). Quadratic ReDoS in the Markdown attribute parsers `createBlockMarkdownSpec` and `createInlineMarkdownSpec`. Affects `@tiptap/core` >= 3.7.0, < 3.30.5. `@tiptap/markdown` isn't installed, so exposure is probably low (unverified).
  - `npm audit --omit=dev` reports `@tiptap/core` as **high** and 44 further `@tiptap/*` packages as moderate, all transitively.
  - `@tiptap/extension-link` GHSA-vhrc-hgrq-x75r (< 2.10.4) doesn't affect us.
- **License and commercial direction:** every installed `@tiptap/*` package is MIT (from the lockfile). In June 2025 Tiptap open-sourced 10 former Pro extensions under MIT and removed its free Cloud plan. The paid tier is now Cloud: collaboration hosting, comments, document history and the AI toolkit ([Tiptap blog](https://tiptap.dev/blog/release-notes/were-open-sourcing-more-of-tiptap), [HN](https://news.ycombinator.com/item?id=44202103), [pricing](https://tiptap.dev/pricing)). We depend on none of the paid pieces. The core staying MIT is the stated position, but the future is (unverified).
- **Alternatives:** raw ProseMirror (Tiptap is a layer over it) or Lexical. Either would be a rewrite of the WYSIWYG editor, its collaboration binding and its mentions, with no health gain. The same family publishes `@tiptap/y-tiptap`, so the Yjs integration stays in-family.
- **Shakiness:** high churn, and minor releases arrive weekly. Monetization pressure is worth watching. The dependency is too large to own.
- **Verdict: KEEP-WATCH, and upgrade all `@tiptap/*` to ≥ 3.30.5 (latest 3.31.3) now.** Also declare `@tiptap/core` and `@tiptap/y-tiptap` as devDependencies so the test file doesn't rely on undeclared packages. Monitor the licence and open-core boundary.

### monaco-editor

- **Use:** Markdown, code and AsciiDoc editors, the diff and conflict views, the glossary import and inbox review, plus a custom Yjs binding (`composables/monacoYjsBinding.js`). 11 src files import it, 10 test files. `boot/monaco.js` sets up 5 workers (editor, json, css, html, ts).
- **Health:** a Microsoft org repo: last push 2026-09-13, 859 open issues, 46.7k stars. 4 stable releases in 12 months, 6.33M downloads/wk. Still **pre-1.0 after 10 years** (0.56.0).
  - `npm audit` flags monaco-editor (low) through its bundled `dompurify@3.4.8`, which has 4 moderate advisories and is fixed after 3.4.12.
  - In the current `assets/` build, `ts.worker` is **6.9 MB** and `editor.api` is 2.65 MB.
- **Alternatives:** CodeMirror 6 is modular and much smaller (search sources cite about 300 KB vs 5-10 MB, unverified), better on mobile, and has `@codemirror/merge` for diffs and `y-codemirror.next` for Yjs.
  - CM6 health: `@codemirror/view` 6.43.11 published 2026-09-03, 10.6M downloads/wk.
  - It has a single maintainer (marijnh, 1758 commits).
  - Development has moved from GitHub to a self-hosted Forgejo at code.haverbeke.berlin; `codemirror/dev` on GitHub is now **archived** ([announcement](https://discuss.codemirror.net/t/codemirrors-migration-to-forgejo/9706)).
  - Migration cost is high: 11 files plus tests, the custom Yjs binding, `helpers/markdownInsert.js`, `helpers/monacoTheme.js` and the diff dialogs. Rough estimate: multiple weeks.
- **Shakiness:** not shaky (Microsoft). The problems are weight and the pre-1.0 label.
- **Verdict: KEEP-WATCH.** Monitor the dompurify advisory until Monaco ships dompurify > 3.4.12. Cheap win to check first: whether the 6.9 MB TypeScript worker is needed at all, which is only true if we edit JS/TS with language services (unverified). CM6 becomes the better choice if mobile editing or bundle size becomes a priority. Its single maintainer and off-GitHub hosting are the trade-off.

### lowlight

- **Use:** syntax highlighting for code blocks in the WYSIWYG editor. 1 src file (`EditorWysiwyg.vue`, `createLowlight(common)`). It is the required input of `@tiptap/extension-code-block-lowlight`.
- **Health:** last release 3.3.0 on 2024-12-14; repo last pushed the same day. 8.97M downloads/wk, 5 open issues. wooorm (225 commits) is the sole maintainer, backed by the unified collective (unverified). No advisories. The underlying `highlight.js` 11.12.0 was published 2026-08-12.
- **Alternatives:** Shiki, which would need a different Tiptap extension. No reason to switch.
- **Shakiness:** solo maintainer and quiet, but it is a thin wrapper over highlight.js and feature-complete.
- **Verdict: KEEP.**

### ky

- **Use:** the API client (`boot/api.js` becomes the `API_CLIENT` global, referenced in 126 src files). Four more files import `isTimeoutError` directly.
- **Health:** 2.1.0 published 2026-08-28, 11 stable releases in 12 months, 5.05M downloads/wk. **1 open issue**, 17k stars. sindresorhus is the solo maintainer; sholladay is second with 40 commits. No advisories.
- **Alternatives:** native `fetch` plus a small wrapper (~80-120 lines for prefix, JSON, hooks, timeout and retry). That would work, but it isn't worth doing given 126 call-site files and ky's health.
- **Shakiness:** solo maintainer, but very well maintained.
- **Verdict: KEEP.** Bump to 2.1.0.

### mitt

- **Use:** the `EVENT_BUS` global (`boot/eventbus.js`, 5 lines), referenced in 15 src files: about 32 `emit`, 18 `on` and 11 `off` calls. The `*` wildcard is never used.
- **Health:** last release 3.0.1 on 2023-07-04, last commit the same day. 22.7M downloads/wk, 27 open issues, developit solo. No advisories.
- **Alternatives:** native `EventTarget` with `CustomEvent`, or an in-house Map-of-Sets emitter (~20 lines).
- **Shakiness:** stale, but finished. It is ~200 bytes, has no dependencies, and is pinned exactly with lockfile integrity.
- **Verdict: KEEP.** It could be owned in 20 lines if we ever want one fewer package, but there is no pressure to.

### uuid

- **Use:** `v4` ids in 6 src files: editor store, import batch, group rules, page relations, nav items, admin auth. The prior audit kept it deliberately, because `crypto.randomUUID` needs a secure context. Not re-litigated here.
- **Health:** 14.0.2 published 2026-08-18, 7 stable releases in 12 months, **206.8M downloads/wk**, 1 open issue. uuidjs org, two co-maintainers (ctavan 247 commits, broofa 246).
  - Advisory GHSA-w5hq-g745-h8pq (buffer bounds in v3/v5/v6, 2026-04) is fixed in 14.0.0, and we don't use those versions.
- **Verdict: KEEP.**

### fuse.js

- **Use:** fuzzy filtering in `components/FileManager.vue` (1 src file, `fuse.js/basic`).
- **Health:** 7.5.0 published 2026-07-13, 6 stable releases in 12 months, 9.81M downloads/wk, 12 open issues. krisk is effectively solo (813 commits). Apache-2.0. No advisories.
- **Alternatives:** a substring or `Intl.Collator`-based filter would lose fuzzy ranking. `basic` is already the slim build.
- **Verdict: KEEP.**

### sortablejs

- **Use:** **not imported directly**. It is the required peer of `sortablejs-vue3` (`^1.15.0`) and so must stay declared.
- **Health:** 1.15.7 published 2026-02-11, the only release in 12 months; last commit 2026-03-24. **527 open issues**. The bus factor is effectively 2 (RubaXa 591 commits, owen-m1 185). 2.98M downloads/wk. No advisories.
- **Alternatives:** `@atlaskit/pragmatic-drag-and-drop` 3.1.0 (Atlassian, 1.02M downloads/wk, last push 2026-09-12). It is framework-agnostic and actively developed, but has a different model and would mean rewriting both drag lists.
- **Shakiness:** slow maintenance and a large backlog. The dependency is contained, though: 2 drag lists.
- **Verdict: KEEP-WATCH.** If it goes dormant, pragmatic-drag-and-drop is the replacement.

### sortablejs-vue3

- **Use:** the `<Sortable>` component in 2 src files (`NavItemEditor.vue`, `pages/AdminLogin.vue`). No tests cover it.
- **Health:** 1.3.0 published 2025-08-20, no release in 12 months, last commit the same day. **19.5k downloads/wk**, 39 open issues, 414 stars. maxleiter is the solo maintainer (53 commits).
- **Alternatives:**
  - `@vueuse/integrations` `useSortable`: still sortablejs underneath, 2.49M downloads/wk, but it would add a dependency.
  - `vuedraggable@next`: 4.1.0 is stuck on `next`, last modified 2023. Worse.
- **Shakiness:** solo, low adoption, stale. The published ES build is only **4 KB**.
- **In-house:** a ~60-80 line Vue component or composable over `sortablejs` (create on mount, destroy on unmount, emit `update`/`end`) replaces it outright.
- **Verdict: IN-HOUSE-CANDIDATE.** It is small, shaky and used in 2 places.

### browser-fs-access

- **Use:** file save and open dialogs. 7 src files, 5 test files, 12 call sites (11 `fileSave`, 1 `fileOpen`): exports, recovery codes, page history, glossary, group rules.
- **Health:** 0.38.0 published 2025-06-18; last commit the same day. 646k downloads/wk, 10 open issues. It sits in the GoogleChromeLabs org but is effectively solo (tomayac 193 commits, next contributor 20). Pre-1.0. No advisories.
- **Alternatives:** native `showSaveFilePicker` / `showOpenFilePicker`, which remain Chromium-only (unverified today), so the fallback is the value this library adds.
- **In-house:** about 50-70 lines: feature-detect the picker, else a Blob plus an `<a download>` click, else a hidden `<input type=file>`.
- **Shakiness:** low. It is pre-1.0 and solo, but small and contained.
- **Verdict: KEEP-WATCH.** If it stays unmaintained another year, in-house the ~60 lines.

### d3-force, d3-quadtree, d3-selection, d3-zoom

- **Use:** the page graph. `pages/graphSimulation.js` (199 lines) uses `forceSimulation`/`forceLink`/`forceManyBody`/`forceCenter`/`forceCollide`, `select` and `zoom`. `pages/Graph.vue` uses `forceCenter`/`forceCollide`, `quadtree` and `zoomIdentity`. 2 src files in total.
- **Health:** every module's last publish was 2021-06; repo pushes were 2023-10 to 2025-01. Weekly downloads: d3-force 17.3M, d3-quadtree 17.6M, d3-selection 24.5M, d3-zoom 23.2M. mbostock and Fil, backed by Observable (unverified). Open issues: 27, 9, 16, 23. No advisories. None are archived.
- **Alternatives:** none needed. `d3-selection` is only there because `d3-zoom` binds through a selection. Graphology/sigma would mean a full redesign of the graph.
- **Shakiness:** "done" software, not abandoned. It is stable ISC-licensed math with no dependency churn. `d3-force` is not small enough to own sensibly (velocity-Verlet plus a Barnes-Hut many-body force). `d3-quadtree` could be owned (~150 lines), but gains nothing.
- **Verdict: KEEP** (all four).

### slugify

- **Use:** path slugs in 4 src files (`ImportBatchPageDialog.vue`, `TreeBrowserDialog.vue`, `FolderRenameDialog.vue`, `FolderCreateDialog.vue`), 5 calls, always `{ lower: true, strict: true }`. The backend does not use this package (`models/rendering.ts` has its own `slugifyHeading`).
- **Health:** 1.6.9 published 2026-04-01, 2 releases in 12 months, 12.65M downloads/wk, 45 open issues. Three npm maintainers (simov, Trott, JoshuaKGoldberg); repo last pushed 2026-06-29. No advisories.
- **Alternatives:** `String.prototype.normalize('NFKD')` plus stripping combining marks and `[^a-z0-9]`, about 10 lines. That only handles Latin diacritics: it drops ß, Cyrillic, Greek and similar instead of transliterating them the way slugify's charmap does. That would silently change the paths users get.
- **Verdict: KEEP.** Healthy, and its transliteration table is the real value.

### text-case

- **Use:** 1 src file (`helpers/pathHumanize.js`). Seven imports: `camelCase`, `camelCaseTransform`, `pascalCase`, `pascalCaseTransform`, `titleCase`, `lowerCase`, `upperCase`. It feeds `humanizePathSegment`.
  - Input is already constrained to `/^[a-z0-9-]+$/` and split on `-`.
  - The file already contains its own title-case minor-word list and acronym logic.
- **Health:** 1.2.11 published 2026-05-19, 6 releases in 12 months. **100k downloads/wk, 17 stars**, 0 open issues. **A single contributor** (idimetrix, 122 commits).
  - It pulls in **20 `text-*` sub-packages**, all from that same account, so 21 packages depend on one publisher's npm credentials.
- **Alternatives:** `es-toolkit/string` (already a dependency) exports `camelCase`, `pascalCase`, `lowerCase` and `upperCase`, but without a per-word `transform` hook, which is the part this helper needs.
- **In-house:** about 30-40 lines. Split on `-`, map each word through the acronym-or-fallback transform, then join: `''` with first-lower for camelCase, `''` for pascalCase, `' '` for titleCase. Every transform rule already lives in `pathHumanize.js`.
- **Verdict: IN-HOUSE-CANDIDATE.** A solo, low-adoption package with a 21-package publish footprint, serving one tiny, fully-specified helper.

### turndown

- **Use:** HTML-to-Markdown conversion for rich paste (`helpers/htmlToMarkdown.js`, 1 src file; its one caller is `EditorMarkdown.vue`).
- **Health:** 7.2.4 published 2026-04-03, 3 releases in 12 months. 6.65M downloads/wk, 144 open issues. mixmark-io org; domchristie wrote 365 commits, with martincizek and pavelhoral also active. Repo last pushed 2026-09-03. No advisories.
- **Alternatives:** `rehype-remark` (the unified stack) is heavier, and the custom OneNote and Word rules here would need rewriting.
- **Verdict: KEEP.**

### turndown-plugin-gfm

- **Use:** `tables` and `taskListItems` rules in `helpers/htmlToMarkdown.js`. Its strikethrough rule is deliberately not used.
- **Health:** **last publish 2018-05-11 (1.0.2)**, repo (now `mixmark-io/turndown-plugin-gfm`) last pushed 2023-05-19. 21 open issues, and table PRs such as #31 were never merged. domchristie is the only npm maintainer. Still 1.03M downloads/wk.
- **Alternatives:** **`@joplin/turndown-plugin-gfm`**:
  - 1.0.68, published **2026-09-07**; 3 releases in 12 months, 698k downloads/wk.
  - 3 npm maintainers (laurent22, calebjohn, tessus), published from the Joplin monorepo (`packages/turndown-plugin-gfm`; joplin last pushed 2026-09-13, 56k stars).
  - Verified from the packed tarball: it exports `gfm`, `highlightedCodeBlock`, `strikethrough`, **`tables`** and **`taskListItems`**, so it is a drop-in import swap. It ships a CJS `main` only, which Vite handles.
  - Behaviour changes to check with tests: headerless tables are rendered instead of left as HTML, newlines inside cells become `<br>`, and cells are padded to 3 characters.
  - Caveat: its npm `repository` field still points at the archived `laurent22/joplin-turndown-plugin-gfm`, whose README redirects to the monorepo.
  - `@truto/turndown-plugin-gfm` is an ESM fork of Joplin's with faster tables (from search, unverified). A smaller community.
- **In-house:** possible (~120-150 lines for the two rules), but the maintained fork is cheaper.
- **Verdict: REPLACE with `@joplin/turndown-plugin-gfm`.** A one-line import change plus the `htmlToMarkdown` test suite.

### @twemoji/api

- **Use:** emoji-to-SVG rendering in `renderers/markdown.js`, plus the build-time coverage check in `vite.config.js` (`verifyTwemojiCoverage`).
- **Health:** this is the community fork (jdecked/twemoji) after Twitter/X dropped Twemoji. 17.0.3 published 2026-06-01, 4 releases in 12 months. **Only 29k downloads/wk.** 2 npm maintainers (jdecked, `boywithkeyboard_old`). Repo last pushed 2026-06-01, 80 open issues. Historically WebReflection was the top contributor (101 commits) with jdecked at 80. License MIT AND CC-BY-4.0. No advisories.
- **Evidence of fragility:**
  - `vite.config.js` pins `@twemoji/api` at 17.0.2 and overrides `@twemoji/parser` to 17.0.1. Per the in-repo comment, parser 17.0.2 (used by 17.0.3) "stopped matching ✌️ ☝️ 🕵️ 🏋️ and six others" (not re-verified by me). A patch release regressed core behaviour.
  - Its published `dependencies` include `fs-extra ^8`, `jsonfile ^5` and `universalify ^0.1`: Node filesystem packages declared by a browser library, which is sloppy packaging.
- **Alternatives:**
  - Native emoji fonts (no images). A product change, and inconsistent across operating systems.
  - Fluent Emoji or Noto Emoji assets (the repo already has `dev/noto-emoji-build/`) (unverified fitness).
  - The parser itself is regex-driven. Owning one is possible but not small, because it has to track Unicode updates.
- **Verdict: KEEP-WATCH.** Low adoption, 2 people, and a regressed patch. The build-time coverage gate already mitigates it well. Re-test on each parser release.

### twemoji-assets (GitHub tarball URL dependency)

- **Use:** the 4009 SVG files (18 MB) that the Vite plugin copies into `assets/_assets/svg/twemoji/` and serves in dev. Nothing imports it.
- **What the pattern actually does (verified):**
  - `package-lock.json` records the `https://codeload.github.com/...v17.0.3` URL **with a sha512 `integrity`**. A retagged or altered tarball makes `npm ci` fail rather than install different bytes.
  - The GitHub release v17.0.3 is **not an immutable release** (`immutable=false`), so the tag can be moved. The integrity hash is the only guard.
  - The tarball is the repo root, which *is* the `@twemoji/api` package: `npm ls` shows `twemoji-assets@npm:@twemoji/api@17.0.3`. It therefore installs a **second copy of @twemoji/api** and hoists `@twemoji/parser@17.0.2` (the very version the pin avoids) to the top level, along with its `fs-extra`/`jsonfile`/`universalify` dependencies. 35 MB on disk.
  - There are no install scripts (`scripts` has no `*install*`), so installing runs no code.
  - It has no npm provenance or signature. `npm audit` sees it only as `@twemoji/api@17.0.3`. `npm-check-updates` and Dependabot cannot bump a tag URL (unverified for Dependabot). Installs also depend on codeload.github.com being available.
- **Alternatives:**
  - `@twemoji/svg` stopped at 15.0.0 (last modified 2023-12). Confirmed stale, as the in-repo comment says.
  - Pin by commit SHA instead of tag: `codeload.github.com/jdecked/twemoji/tar.gz/<sha>`. The URL itself becomes immutable, and the integrity hash stays.
  - Mirror or vendor: generate only the SVGs reachable from `markdown-it-emoji`'s shortcode map (the set `verifyTwemojiCoverage` already computes) into a committed or release-hosted bundle, following the `icons.generated.js` precedent. This trades repo weight for supply-chain independence.
- **Verdict: KEEP-WATCH.** The integrity hash makes it fail-closed, so the risk is availability and stealth, not substitution. Cheapest improvement: **switch the tag URL to a commit-SHA URL**. Document that tooling can't update it, so the `@twemoji/api` and assets pair is bumped by hand with the coverage gate.

### unicode-emoji-json (dev)

- **Use:** `scripts/generate-emoji.mjs` (build-time generator, 1 file).
- **Health:** 0.9.0 published 2026-04-18, 182k downloads/wk, 1 open issue. muan is the solo maintainer (95 commits). Pre-1.0 but data-only, and it never ships to the browser.
- **Verdict: KEEP.** The data is committed through the generator, and `emoji:check` detects drift.

### tailwindcss and @tailwindcss/vite

- **Use:** all styling. Loaded through the Vite plugin; 6 `.vue`/`.css` files use `@apply`, `@theme` or `@import 'tailwindcss'`, and the utility classes are everywhere.
- **Health:** both packages are at latest (4.3.3, 2026-07-16), with about 16 and 14 stable releases in 12 months. 92.7M and 32.7M downloads/wk. The Tailwind Labs company repo was last pushed 2026-09-08 with only 70 open issues. Top committers are adamwathan, RobinMalfait and thecrypticace. No advisories.
- **Verdict: KEEP** (both).

### Group findings

1. **Security, do now:** upgrade every `@tiptap/*` package from 3.30.2 to ≥ 3.30.5 (latest 3.31.3). GHSA-cp6q-959q-f8rh (the `mergeAttributes` `__proto__` XSS vector, plausibly reachable through collaborative content) and GHSA-j95f-988m-3j2f (ReDoS) both affect our pin, and `npm audit` flags 45 `@tiptap/*` entries. At the same time, add `@tiptap/core` and `@tiptap/y-tiptap` to devDependencies, since `EditorWysiwyg.collab.test.js` imports both undeclared.
2. **Replace `turndown-plugin-gfm`** (untouched since 2018) with `@joplin/turndown-plugin-gfm` 1.0.68. It exports the same `tables` and `taskListItems`, so it is a 1-line import swap. Re-run `htmlToMarkdown` tests for the headerless-table and `<br>`-in-cell behaviour changes.
3. **In-house two small, shaky packages:**
   - `text-case`: solo publisher and a 21-package footprint for one ~40-line helper in `pathHumanize.js`.
   - `sortablejs-vue3`: solo, 19k/wk, a 4 KB wrapper used in 2 files. Replace with a ~70-line component over `sortablejs`.
4. **Harden `twemoji-assets`:** pin the tarball by commit SHA rather than a mutable tag (the release isn't immutable). Record that audit and update tooling can't see it, and that it installs a duplicate `@twemoji/api`. Keep the build-time coverage gate as the real safety net.
5. **Monaco weight and advisory:** the build ships a 6.9 MB `ts.worker` and 2.65 MB `editor.api`, and bundled `dompurify@3.4.8` has 4 moderate advisories. Check whether the TS worker is needed, and track the Monaco release that bumps dompurify. CodeMirror 6 is the long-term alternative if mobile editing or bundle size matters, at a multi-week migration cost and with a single maintainer who has moved off GitHub.

Patch-level bumps available with no concerns: vue 3.5.42, vue-router 5.3.1, vue-i18n 11.4.10, ky 2.1.0.

---

## D. Rendering pipeline + embeddable blocks

Evidence gathered live on 2026-09-13 from `npm view`, `gh api repos/...`, `gh api /advisories`, the
npm downloads API (week 2026-09-05..11), GitHub release notes/CHANGELOGs, and greps of the repo
(excluding `node_modules`, `assets`, `compiled`). "Commits/yr" = commits on the default branch since
2025-09-13 (the API caps it at 100). Pinned versions are exact in each `package.json` and match the lockfiles.

| Package | Workspace(s) | Pinned → Latest | Last publish | Maintainers/backing | Verdict | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| markdown-it | frontend, backend | 15.0.0 → **15.0.2** | 2026-09-11 | markdown-it org (puzrin, rlidwka); 21.4M/wk | KEEP (bump now: DoS fixes) | Med |
| markdown-it-emoji | frontend, backend | 3.1.0 = 3.1.0 | 2026-07-22 | markdown-it org; 524k/wk | KEEP | Low |
| @types/markdown-it-emoji | backend | 3.0.1 = 3.0.1 | 2024-05-01 | DefinitelyTyped | CONSIDER-ALTERNATIVE (local `declare module` shim) | Low |
| markdown-it-abbr | frontend | 2.0.0 = 2.0.0 | 2023-12-06 | markdown-it org; 252k/wk | KEEP | Low |
| markdown-it-attrs | frontend | 5.0.1 = 5.0.1 | 2026-07-27 | 1 human (arve0), heavy Copilot-authored PRs; 199k/wk | KEEP-WATCH | Med |
| markdown-it-expand-tabs | frontend | 1.0.13 = 1.0.13 | 2018-03-06 | 1 (revin), repo idle since 2020; 9.5k/wk | IN-HOUSE-CANDIDATE | Low |
| markdown-it-footnote | frontend | 4.0.0 = 4.0.0 | 2023-12-06 | markdown-it org; 468k/wk | KEEP | Low |
| markdown-it-mark | frontend | 4.0.0 = 4.0.0 | 2023-12-05 | markdown-it org; 358k/wk | KEEP | Low |
| markdown-it-sub | frontend | 2.0.0 = 2.0.0 | 2023-12-05 | markdown-it org; 369k/wk | KEEP | Low |
| markdown-it-sup | frontend | 2.0.0 = 2.0.0 | 2023-12-05 | markdown-it org; 409k/wk | KEEP | Low |
| markdown-it-task-lists | frontend | 2.1.1 = 2.1.1 | 2018-03-06 | 1 (revin), repo idle since 2022; 2.2M/wk | IN-HOUSE-CANDIDATE (vendor as-is) | Low |
| highlight.js | frontend, backend | 11.12.0 = 11.12.0 | 2026-08-12 | highlightjs org, revived Jun 2026 after ~1 yr dormant; 26.4M/wk | KEEP-WATCH | Med |
| asciidoctor | frontend | 4.0.11 = 4.0.11 | 2026-08-18 | asciidoctor org, one active committer (ggrossetie); 26k/wk | KEEP-WATCH | Med |
| katex | frontend, blocks | 0.18.4 → 0.18.7 | 2026-09-06 | KaTeX org (Khan Academy lineage), 7 npm maintainers; 18.9M/wk | KEEP | Low |
| @mathjax/src | blocks | 4.1.3 = 4.1.3 | 2026-07-03 | MathJax org (dpvc, zorkow); 92k/wk | KEEP | Low |
| @mathjax/mathjax-newcm-font | blocks | 4.1.3 = 4.1.3 | 2026-07-03 | MathJax org; 104k/wk | KEEP | Low |
| @mathjax/mathjax-mhchem-font-extension | blocks | 4.1.3 = 4.1.3 | 2026-07-03 | MathJax org; 6.9k/wk | KEEP | Low |
| mermaid | blocks | 11.17.0 → 11.17.2 (12.0.0 major out) | 2026-09-10 | mermaid-js org, 5 npm maintainers; 12.1M/wk | KEEP-WATCH | Med |
| leaflet | blocks | 1.9.4 = 1.9.4 (2.0.0-alpha.1) | 2023-05-18 (stable) | Leaflet org (mourner et al.); 5.3M/wk | KEEP-WATCH | Low |
| lit | blocks | 3.3.3 = 3.3.3 | 2026-05-14 | Google / lit org, 8 npm maintainers; 5.2M/wk | KEEP | Low |
| pdfjs-dist | blocks | 6.2.108 → 6.3.289 | 2026-08-29 | Mozilla; 19.7M/wk | KEEP (track latest) | Med |
| swagger-ui | blocks | 5.32.14 → 5.32.15 | 2026-09-04 | SmartBear / swagger-api org; 93k/wk | KEEP | Low |
| asciinema-player | blocks | 3.17.0 = 3.17.0 | 2026-06-30 | asciinema org, effectively 1 dev (ku1ik); 60k/wk | KEEP-WATCH | Low |
| pako | blocks | 3.0.1 → 3.0.2 | 2026-09-12 | nodeca org (puzrin); 83M/wk | CONSIDER-ALTERNATIVE (native `DecompressionStream`) | Low |
| uqr | blocks | 0.1.3 = 0.1.3 | 2026-04-03 | unjs org (antfu, pi0); 3.2M/wk | KEEP-WATCH | Low |

---

### markdown-it

- **Use:** the core parser for the page renderer (`frontend/src/renderers/markdown.js`) and for comments (`backend/modules/comments/default/comments.ts`, `linkify: true`). 2 production import sites, 3 test files.
- **Health:** 15.0.2 came out 2026-09-11, and a `v14-legacy` 14.3.2 on 2026-09-12. The repo was pushed 2026-09-12 with 100+ commits in the last year (27 of the last 30 by puzrin). 8 open issues+PRs, 21.9k stars, org-owned. Not deprecated or archived.
- **Security (important):** we pin **15.0.0**. Its CHANGELOG lists these fixes after that version:
  - 15.0.1: quadratic complexity in fuzzy-link replacement and in the linkify scheme backscan.
  - 15.0.2: quadratic smartquotes, plus a cap of 1000 on the stack of unmatched openers.
  - The backend renders untrusted comment Markdown server-side with `linkify: true`, so the linkify fix is a real server-side DoS surface.
  - GHSA-6v5v-wf23-fmfq (smartquotes, published 2026-06-15) is recorded as `<= 14.1.1`. The 15.0.2 notes describe another smartquotes fix on top of that.
- **Alternatives:** none worth the move. micromark/remark would mean rewriting our ~8 in-house plugins (`renderers/modules/`) and the table/glossary/blocks rules.
- **Shakiness:** low. Two long-standing maintainers, an org, and very high downloads. 15.x shipped breaking changes (removed `lib/*` subpath exports, linkify-it v6), which the variances file already absorbed.
- **Verdict:** KEEP. Bump both workspaces to 15.0.2 now for the DoS fixes.
- **Incidental bug found while auditing (not a dependency issue):** `markdown.js:221` passes `typography: config.typographer`. markdown-it's option is `typographer` (checked in `dist/markdown-it.d.mts:62`), and it ignores unknown keys. So the admin "Typographer" toggle and the `quotes` style setting have no effect today. No test covers it.

### markdown-it-emoji

- **Use:** emoji shortcodes in both renderers. `lib/data/full.mjs` is also read by `frontend/vite.config.js` and `frontend/scripts/generate-emoji.mjs`. 4 sites.
- **Health:** 3.1.0 published 2026-07-22 after a 2.5-year gap. Repo pushed 2026-09-13, 9 commits/yr, 7 open, org-owned.
- **Alternatives:** `@mdit/plugin-emoji` 1.2.1 has 238 downloads/wk and a single maintainer, which is worse on every axis.
- **Shakiness:** low. The runtime is ~196 lines; the rest is data. It's org-owned and depends on nothing exotic.
- **Verdict:** KEEP.

### @types/markdown-it-emoji

- **Use:** types for the backend `comments.ts` import.
- **Health:** 3.0.1 published 2024-05-01. It depends on `@types/markdown-it ^14`, so the backend lock carries `@types/markdown-it@14.2.0` next to markdown-it 15's bundled types. markdown-it 15's CHANGELOG says "Remove `@types/markdown-it` if you used it." `npm run typecheck` passes today with no output.
- **Alternatives:** a 3-line ambient `declare module 'markdown-it-emoji'` in `backend/types/`, typed against markdown-it 15's own `PluginSimple`. That removes two stale `@types` packages and the risk of two MarkdownIt type trees disagreeing.
- **Verdict:** CONSIDER-ALTERNATIVE (local shim). Low value, trivial cost.

### markdown-it-abbr, markdown-it-footnote, markdown-it-mark, markdown-it-sub, markdown-it-sup

- **Use:** one import each in `markdown.js`, used as `.use(...)` with defaults.
- **Health:** all live in the markdown-it org and were last published Dec 2023 (the ESM 2.0/4.0 line). Their repos were pushed Jul 2026 (a maintenance sweep), with 0–1 commits/yr and 2–4 open items each. 250k–470k downloads/wk each. No advisories.
- **Source size** (checked in `node_modules`): abbr 143 lines, footnote 353, mark 123, sub 60, sup 60.
- **Alternatives:** the `@mdit/*` family (mdit-plugins/mdit-plugins, 38 packages, all peer-depending on `markdown-it ^15.0.1`).
  - It is very active: 100+ commits/yr, last release 2026-09-07.
  - But it is effectively **one maintainer** (Mister-Hope: 687 commits in total and 14 of the last 30, the other 16 being renovate). It has 208 stars and ~11–15k downloads/wk per plugin.
  - Consolidating onto it would swap an org with two maintainers for a bus factor of 1, plus frequent churn (minors every few weeks). That is not an upgrade.
- **Shakiness / in-house:** they're small enough to own, but there's no reason to. They're feature-complete, org-owned and compatible with markdown-it 15.
- **Verdict:** KEEP (all five).

### markdown-it-attrs

- **Use:** `{#id .class target=…}` syntax, restricted with `allowedAttributes: ['id', 'class', 'target']` (`markdown.js:267`). It replaced markdown-it-decorate in the prior audit. 1 site, 1 test file. This is security-relevant because it sits on the path where attributes get injected.
- **Health:** very active.
  - Published 5.0.0 (2026-05-26) and 5.0.1 (2026-07-27). 40 commits/yr, pushed 2026-09-13, 6 open items, no advisories, 199k downloads/wk.
  - Owned by a user account, not an org: one human maintainer, arve0.
  - **14 of the last 30 commits are authored by `Copilot`** (e.g. v4.5.0's "Fix quoted attribute parsing…"). Parser changes in an attribute-injection plugin are merged from AI-agent PRs.
  - 5.0.0 was a breaking change to fence-renderer installation.
- **Alternatives:** `@mdit/plugin-attrs` (single maintainer, ~15k/wk) is no better. Our whitelist plus the server-side sanitizer (`helpers/htmlSanitizePolicy.ts`) is the real control, so upstream parser churn is contained.
- **Shakiness / in-house:** the core is ~1,220 lines across `index.js`, `patterns.js` and `utils.js`, excluding the 9.6k-line browser bundle. That's too big to own casually.
- **Verdict:** KEEP-WATCH. Review the diff of every minor/major bump (Copilot-authored parser changes), and keep a regression test pinning that non-whitelisted attributes such as `onclick` and `style` are dropped.

### markdown-it-expand-tabs

- **Use:** expands tabs in fenced code to `config.tabWidth` spaces (`markdown.js:272`). 1 site, no tests.
- **Health:** last publish 2018-03-06. Repo last pushed 2020-05-23, 5 stars, 3 open, 9.5k downloads/wk. CJS only, and it depends on `lodash.repeat` (last touched 2022).
- **Source:** **43 lines** (checked). It wraps `md.renderer.rules.fence` and replaces leading tabs using `lodash.repeat`.
- **Alternatives:** none maintained. `String.prototype.repeat` does the whole job natively.
- **Shakiness / in-house:** abandoned, single-maintainer, and it drags a lodash-family transitive dependency into a codebase that has banned lodash. A ~15-line in-house `renderers/modules/markdown-it-expand-tabs.js` with a co-located test is the obvious safeguard.
- **Verdict:** IN-HOUSE-CANDIDATE. Rewrite, and drop the dependency plus `lodash.repeat`.

### markdown-it-task-lists

- **Use:** GFM checkboxes, `{ label: false, labelAfter: false }` (`markdown.js:271`). 1 site. Kept over `@mdit/plugin-tasklist` on purpose (the variances entry citing the #1180 decision).
- **Health:** last publish 2018-03-06, repo last pushed 2022-06-29, 8 open items, one user-account maintainer. Still 2.2M downloads/wk. CJS, ISC licence. It also uses module-level mutable option state (`disableCheckboxes` etc.), which is shared across MarkdownIt instances.
- **Source:** **116 lines** (checked).
- **Alternatives:** not re-litigated. The #1180 decision to keep this markup stands.
- **Shakiness / in-house:** abandoned but frozen and tiny. Vendoring it verbatim (ISC, keep the notice) into `renderers/modules/` keeps the exact checkbox markup #1180 protects, so it doesn't re-open that decision. It also removes the stale-dependency risk and lets us fix the module-global state.
- **Verdict:** IN-HOUSE-CANDIDATE (low priority). Vendor as-is; the markup is unchanged.

### highlight.js

- **Use:**
  - `frontend/src/renderers/markdown.js` and `components/EditorCodeBlockMenu.vue` use `highlight.js/lib/common`.
  - `components/UtilCodeEditor.vue` uses `lib/core` plus 5 languages.
  - `backend/modules/comments/default/comments.ts` imports the **full** `highlight.js` (~190 grammars) to highlight untrusted comment code server-side.
  - 8 import lines in total.
- **Health:**
  - The 11.11.2 release notes (2026-06-23) say: "highlight.js has been inactive since last summer… I'll need the community's help."
  - Since then: 11.12.0 on 2026-08-12, and a burst of merged PRs in Aug 2026 with joshgoebel active (refactors on 08-14 and 08-19).
  - 109 open issues+PRs, 25k stars, 26.4M/wk. The only advisories are from 2020 (ReDoS, prototype pollution in v9/v10).
  - The old "looking for maintainers" issue (#1678) is still the backdrop.
- **Alternatives:** shiki 4.4.3 (antfu org, 17.2M/wk, active) gives TextMate-grammar accuracy. It is async-first, heavier, and would mean rethinking the synchronous markdown-it `highlight` callback plus the editor's language picker. Not justified unless highlight.js goes dormant again.
- **Shakiness:** medium. It has already had one dormant year, and grammars are a classic ReDoS surface, which matters most on the backend. Far too large to own.
- **Verdict:** KEEP-WATCH. Watch for another stall. Switching the backend import to `highlight.js/lib/common` (matching the frontend) would shrink the server-side grammar and ReDoS surface.

### asciidoctor

- **Use:** `frontend/src/renderers/asciidoc.js` calls `convert(src, { safe: 'secure' })`. 1 site. The `EditorAsciidoc` chunk is 314 KB in `assets/_assets`.
- **Health:**
  - 4.0.0 was published 2026-06-22. Its README now calls it "a native JavaScript implementation of Asciidoctor" rather than the Opal transpile of 2.x/3.x.
  - Then **11 patch releases in 8 weeks**, with 4.0.8 through 4.0.11 landing between Aug 6 and Aug 18, including fixes for passthrough escaping.
  - The wrapper package depends on `@asciidoctor/core` 4.0.11 (3 npm maintainers). 40 of the last 50 commits are ggrossetie's. 13 open items, no advisories, 26k/wk (85k for `@asciidoctor/core`).
- **Alternatives:** none in JS. It's the reference implementation's port.
- **Shakiness:** medium. A freshly rewritten engine that is still churning, one active committer, and `safe: 'secure'` is our only guard on untrusted input before the server sanitizer.
- **Verdict:** KEEP-WATCH. Let 4.0.x settle, and keep a small render/`safe` regression test (there are no asciidoc renderer tests today).

### katex

- **Use:** inline and display TeX in the markdown renderer (`renderers/modules/markdown-it-tex.js`) and in `blocks/block-katex` (with `katex/contrib/mhchem`). 4 import lines, 3 test files. The block-katex bundle is 666 KB.
- **Health:** 0.18.5–0.18.7 published 2026-08-31..09-06 (features and bug fixes, no security entries in the CHANGELOG). 100+ commits/yr, 394 open issues+PRs, 20.4k stars, 18.9M/wk.
  - Past advisories are all fixed by 0.16.21 or earlier (`\htmlData` 2025-01; `\includegraphics`, protocol normalisation and `maxExpand` in 2024).
  - Still pre-1.0 after a decade, but that is a versioning habit, not instability.
- **Alternatives:** Temml 0.13.5 (MathML output, 586k/wk) belongs to ronkok, a KaTeX contributor, with a single maintainer. It's lighter but isn't a stability upgrade.
- **Verdict:** KEEP. Bump to 0.18.7 routinely, and keep `trust` off.

### @mathjax/src, @mathjax/mathjax-newcm-font, @mathjax/mathjax-mhchem-font-extension (one family)

- **Use:** only `blocks/block-mathjax/component.js`: TeX input to SVG output via liteAdaptor, plus ~30 TeX package imports. The compiled `block-mathjax.js` is 1.50 MB. Install footprint is 94 MB (newcm-font alone is 49 MB unpacked).
- **Health:** 4.1.1, 4.1.2 and 4.1.3 were released Feb, May and Jul 2026. Repo pushed 2026-09-12, 100+ commits/yr, 34 open. Two long-time core devs (dpvc 3,658 commits, zorkow 1,814), org-backed. Apache-2.0, no advisories.
- **Is shipping KaTeX and MathJax both justified?** Yes, and it's documented.
  - Task 634's research shows that 2.5.x offered both engines.
  - It also includes a verified construct-by-construct table showing MathJax covers TeX that KaTeX deliberately does not.
  - Both live in separate lazily loaded blocks: no page pays for MathJax unless it uses `::block-mathjax`. The markdown renderer uses only KaTeX, which is synchronous.
  - Dropping MathJax would break imported 2.5.x content that relies on the wider TeX surface.
- **Known debt:** the same decision record notes that `mathjax.asyncLoad` is not wired, so newcm-font's dynamic glyph chunks fail to load. That's a functional gap, not a dependency-health issue.
- **Verdict:** KEEP (all three). Fix the recorded `asyncLoad` follow-on rather than the dependency.

### mermaid

- **Use:** `blocks/block-diagram/component.js` (1 import, 7 test files). It is chunk-split, and several stale duplicate chunks from Aug 20/22 are still sitting in `blocks/compiled/`.
- **Health:**
  - Very active: 5 npm maintainers, 90k stars, 12.1M/wk, but **1,788 open issues+PRs**.
  - **12.0.0 released 2026-09-10.** It's breaking: ES2024 and Safari 17.4+, ELK becomes the default layout, and a new default look. Existing flowcharts re-lay out and recolour unless you set `layout: dagre` / `look: classic`.
  - Heavy advisory history: 11 GHSAs in 2025–2026 (CSS injection, XSS in sequence and architecture labels, prototype pollution, infinite-loop DoS). The latest batch (2026-08-06) is fixed in 11.16.1, so our 11.17.0 is patched.
- **Alternatives:** Kroki / PlantUML (already offered as other blocks) render server-side, but aren't drop-in replacements for client-side mermaid syntax.
- **Shakiness:** not a maintenance risk. The risk is the ongoing sanitisation-bug cadence on author-controlled input.
- **Verdict:** KEEP-WATCH. Stay on current 11.17.x patches (bump to 11.17.2). Adopt 12.x deliberately, with visual review and pinned `layout`/`look` config, because it silently changes every existing diagram. Watch the GHSA feed.

### leaflet

- **Use:** `blocks/block-map/component.js`. Exactly 4 API calls: `L.map`, `L.tileLayer`, `L.marker`, `L.divIcon`. The block-map bundle is 174 KB.
- **Health:**
  - Last stable is 1.9.4 (2023-05-18).
  - 2.0.0-alpha.1 came out 2025-08-16. Issue #9869, retitled "target date for 2.0 is ~~November 2025~~ unknown", was closed 2026-04-12. The `2.0.0-alpha.2` milestone has 5 open / 34 closed.
  - Recent main-branch commits are mostly dependabot and docs. Still 5.3M/wk, 45.6k stars, no advisories, BSD-2.
- **Alternatives:** maplibre-gl 6.9.0 is very active and org-backed, but it is WebGL/vector-first and 20 MB unpacked. It also had a **critical** XSS advisory (GHSA-jrc7-96c5-q579, ≤ 6.4.0, 2026-09-08). That's overkill for our raster-tile markers.
- **Shakiness:** low. 1.9.4 is feature-frozen and stable, and our API surface is tiny, so either a 2.0 ESM migration or a swap is cheap later.
- **Verdict:** KEEP-WATCH. Watch for 2.0 stable. 1.x is fine meanwhile.

### lit

- **Use:** the base class for every block: 30 non-test files in `blocks/` import from `lit`.
- **Health:** 3.3.3 released 2026-05-14 (patch cadence of ~5 months). 45 commits/yr, pushed 2026-09-11. Google-originated with 8 npm maintainers. 21.8k stars, 5.2M/wk, no advisories.
- **Alternatives:** none that make sense. Lit is the reference web-component library, and a rewrite would touch every block.
- **Verdict:** KEEP.

### pdfjs-dist

- **Use:** `blocks/block-pdf/component.js` (`getDocument` with `isEvalSupported: false`, worker via `GlobalWorkerOptions.workerSrc`) and `worker.js`. 2 sites, 1 test file. Compiled: 452 KB block plus a 1.20 MB worker.
- **Health:** Mozilla, monthly releases (6.0.227 2026-05-30 → 6.3.289 2026-08-29), 19.7M/wk.
  - Advisory GHSA-hq66-cqwq-w95j (**high**, arbitrary JS execution from a malicious PDF) affects `>= 5.6.83, < 6.2.108`, published 2026-08-06. **Our pin, 6.2.108, is exactly the first fixed version.**
  - This is the third such high advisory (2022, 2024, 2026).
- **Alternatives:** the browser's native PDF viewer via `<iframe>`/`<object>` avoids shipping a parser entirely, but loses in-page rendering and control.
- **Verdict:** KEEP. Bump to 6.3.289 and treat pdf.js as a "track latest" dependency given its advisory history. `isEvalSupported: false` is correctly set.

### swagger-ui

- **Use:** `blocks/block-openapi/component.js` (UMD bundle plus CSS in the shadow root). 1 site. It is the **largest block**: `block-openapi.js` is 1.59 MB. Lazily loaded only when the tag appears.
- **Health:** SmartBear org, weekly patch releases (5.32.12–5.32.15 over Aug–Sep 2026, including "use scoped DOMPurify instance" in 5.32.15). 1,130 open issues+PRs, 93k/wk. Advisories date only from 2019–2022 (< 4.1.3).
- **Alternatives:**
  - `@scalar/api-reference` 1.68.0 (very active, 745k/wk) was **already evaluated and rejected in code comments**. It is a Vue app that injects its styles into `document.head`, so it breaks the shadow-root styling model, and its standalone build is ~3.3 MB.
  - RapiDoc 9.3.8 was last published 2024-10-11, has 0 commits/yr and one maintainer. It is stale, so not a candidate.
- **Verdict:** KEEP. Size is the only cost, and lazy loading contains it.

### asciinema-player

- **Use:** `blocks/block-asciinema/component.js` (`create`, CSS). 1 site, 1 test file. Bundle 207 KB.
- **Health:** releases 3.15.1 (Feb), 3.16.0 (Jun) and 3.17.0 (2026-06-30). Pushed 2026-09-13, 100+ commits/yr, 6 open, no advisories, 60k/wk. Org-owned, but **48 of the last 50 commits are ku1ik's** (bus factor 1, and he is also the asciinema project lead).
- **Alternatives:** none of comparable quality for `.cast` playback.
- **Shakiness:** bus factor 1, but it's the canonical player for its own format, actively released, and confined to one optional block. Too large to own.
- **Verdict:** KEEP-WATCH. Watch for maintainer inactivity; the impact is limited to one block.

### pako

- **Use:** a single call, `inflateRaw(bytes, { toText: true })`, in `blocks/block-drawio/mxgraph.js:83`, which decompresses draw.io's compressed `<diagram>` payload. 1 site, 1 test file.
- **Health:** 3.0.0 (TypeScript rewrite, named exports) 2026-06-26, then 3.0.1 and 3.0.2 (2026-09-12). The 3.0.2 fixes concern deflate `Z_FIXED` and gzip header time, neither of which is relevant to inflate. nodeca org (the markdown-it maintainers), 0 open items, 83M/wk, no advisories.
- **Alternatives:** native `DecompressionStream('deflate-raw')`.
  - MDN: Baseline widely available since May 2023.
  - Node 18+ has it too, so tests keep working.
  - It is **stream/async-only**, so `decompress()` → `extractModelXml()` → `drawioToSvg()` would have to become async and the block would await it. The migration is small and contained to one file plus its callers and tests.
  - `fflate` is another option (single maintainer; a 2026-07 infinite-loop advisory on unzip), but it's no better than pako.
- **Shakiness:** none. pako is healthy. This is purely about removing a dependency.
- **Verdict:** CONSIDER-ALTERNATIVE (`DecompressionStream`). Low priority: it drops a dependency for one call, at the cost of an async refactor.

### uqr

- **Use:** `blocks/block-qr-code/component.js`, `renderSVG(text, { border: 1, pixelSize: 8 })`. No user-controlled colours are passed. 1 site. Bundle 14.7 KB.
- **Health:** 0.1.3 published 2026-04-03 (it fixed SVG/XML injection via colour attributes, which our pin includes). Previous release 0.1.2 was 2023-08-16. unjs org with npm maintainers pi0 and antfu, 0 open items, 5 commits/yr, 3.2M/wk (mostly transitive through the unjs/nuxt ecosystem, which is an assumption).
- **Alternatives:** `qrcode` 1.5.4 (2024-08-05, 19M/wk, 2 maintainers) is stale and heavier. `lean-qr` 2.7.4 (active, single maintainer, 33k/wk) is no safer.
- **Shakiness / in-house:** pre-1.0 and slow-moving, but the domain is finished: QR encoding doesn't change. The whole library is a **27 KB single ESM file** adapted from Project Nayuki's QR-Code-generator (MIT). If unjs ever abandons it, vendoring that one file (or Nayuki's reference `qrcodegen.ts`) is a cheap, well-understood fallback.
- **Verdict:** KEEP-WATCH. Pre-1.0 isn't a real risk here; vendoring is the escape hatch.

### Group findings

1. **Bump markdown-it 15.0.0 → 15.0.2 in both `frontend/` and `backend/` now.** 15.0.1 and 15.0.2 fix quadratic-complexity DoS in linkify (fuzzy links, scheme backscan) and smartquotes. The backend renders untrusted comments with `linkify: true`. While there, fix `markdown.js:221` `typography:` → `typographer:`: today the admin Typographer toggle and quote styles are silently ignored.
2. **Remove the two abandoned revin plugins.** Rewrite `markdown-it-expand-tabs` in-house (43 lines, last publish 2018, pulls in `lodash.repeat`). Vendor `markdown-it-task-lists` verbatim (116 lines, ISC); the checkbox markup stays identical, so the #1180 keep-decision holds.
3. **The @mdit/* family is not a consolidation target.** It is a single maintainer with ~12–15k downloads/wk per plugin, against the markdown-it org's own plugins at 250k–470k/wk with two long-time maintainers. The org's abbr/footnote/mark/sub/sup are small, feature-complete and markdown-it-15 compatible: keep them.
4. **Security-sensitive libraries need "track latest" discipline, not replacement:** pdfjs-dist (pinned at exactly the high-severity fix 6.2.108; bump to 6.3.289), mermaid (11 advisories in 2025–26; take 11.17.2, adopt 12.0 deliberately since it re-lays out every diagram), and markdown-it-attrs (Copilot-authored parser PRs; review each bump's diff and keep a test that the whitelist drops non-listed attributes). The backend's full `highlight.js` import could become `lib/common` to cut the server-side grammar/ReDoS surface.
5. **Watch, don't act:** highlight.js (revived Jun 2026 after a dormant year), asciidoctor 4.x (fresh native-JS rewrite, 11 patches in 8 weeks, one active committer; add a render test), Leaflet (2.0 stalled at alpha, 1.9.4 fine for our 4-call surface). Two small optional cleanups: replace `@types/markdown-it-emoji` (drags in `@types/markdown-it@14` beside markdown-it 15's bundled types) with a local shim, and swap pako's single `inflateRaw` for native `DecompressionStream`.

---

## E. Tooling / dev-only dependencies

Data pulled live on 2026-09-13 from the npm registry (`npm view`), the npm downloads API, `gh api` (repos, contributors,
`/advisories`), `tsc --listFiles` run in `backend/`, the Node v26.8.1 `doc/api/cli.md`, and vendor docs/blogs.
Anything marked "(unverified)" was not confirmed against a live source. "dl/wk" = npm downloads last week.

| Package | Workspace(s) | Pinned → Latest | Last publish | Maintainers/backing | Verdict | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| typescript | backend | 7.0.2 → 7.0.2 | 2026-07-08 (7.0.2) | Microsoft | KEEP | Low |
| oxlint | backend, frontend, blocks | 1.79.0 → 1.82.0 | 2026-09-07 | oxc / VoidZero | KEEP | Low |
| oxfmt | backend (CI canonical) | 0.64.0 → 0.67.0 | 2026-09-07 | oxc / VoidZero | KEEP-WATCH | Med |
| nodemon | backend | 3.1.14 → 3.1.14 | 2026-02-20 | remy (single) | KEEP-WATCH | Low |
| npm-check-updates | backend, frontend, blocks | 23.0.2 → 23.1.0 | 2026-08-23 | raineorshine (primary) | REMOVE | Low |
| vite | frontend | 8.2.2 → 8.3.0 | 2026-09-10 | VoidZero / Vite team | KEEP | Low |
| @vitejs/plugin-vue | frontend | 6.0.8 → 6.0.8 | 2026-07-21 | Vite team | KEEP | Low |
| vite-plugin-vue-devtools | frontend | 8.2.1 → 8.2.1 | 2026-07-25 | vuejs org (1 npm publisher) | KEEP | Low |
| vitest | frontend, blocks | 4.1.11 → 5.0.0 | 2026-09-03 (5.0.0) | Vitest team / VoidZero | KEEP-WATCH | Low |
| @vue/test-utils | frontend | 2.4.11 → 2.5.0 | 2026-08-27 | Vue team | KEEP | Low |
| happy-dom | frontend | 20.11.6 → 20.14.5 | 2026-09-12 | capricorn86 (de facto single) | KEEP-WATCH | Med |
| jsdom | blocks | 30.0.1 → 30.0.1 | 2026-07-29 | jsdom org (6 maintainers) | KEEP | Low |
| playwright | frontend | 1.62.1 → 1.63.0 | 2026-09-13 | Microsoft | KEEP | Low |
| @playwright/test | e2e | 1.62.1 → 1.63.0 | 2026-09-13 | Microsoft | KEEP | Low |
| sass | frontend | 1.103.1 → 1.104.1 | 2026-09-12 | Sass team (Google-originated) | CONSIDER-ALTERNATIVE (native CSS long-term) | Low |
| cross-env | frontend | 10.1.0 → 10.1.0 | 2025-09-29 | kentcdodds, repo **archived** | REMOVE | Low |
| rollup | blocks | 4.62.5 → 4.63.2 | 2026-09-12 | Rollup team | CONSIDER-ALTERNATIVE (rolldown) | Low |
| @rollup/plugin-commonjs | blocks | 29.0.3 → 29.0.3 | 2026-05-29 | rollup/plugins | KEEP (folds into rolldown move) | Low |
| @rollup/plugin-node-resolve | blocks | 16.0.3 → 16.0.3 | 2025-10-13 | rollup/plugins | KEEP (folds into rolldown move) | Low |
| @rollup/plugin-terser | blocks | 1.0.0 → 1.0.0 | 2026-03-05 | rollup/plugins | KEEP (folds into rolldown move) | Low |
| rollup-plugin-summary | blocks | 3.0.1 → 3.0.1 | 2025-04-08 | yousifalraheem (single, 16★) | IN-HOUSE-CANDIDATE | Med |
| @types/js-yaml | backend | 4.0.9 → 4.0.9 | 2025-08-03 | DefinitelyTyped | REMOVE | Low |
| @types/markdown-it-emoji | backend | 3.0.1 → 3.0.1 | 2025-08-03 | DefinitelyTyped | KEEP | Low |
| @types/node | backend | 26.2.0 → 26.5.1 | 2026-09-13 | DefinitelyTyped | KEEP | Low |
| @types/nodemailer | backend | 8.0.1 → 8.0.1 | 2026-06-10 | DefinitelyTyped | KEEP-WATCH (drop at nodemailer 10) | Low |
| @types/pg | backend | 8.23.1 → 8.23.1 | 2026-08-17 | DefinitelyTyped | KEEP | Low |
| @types/pg-cursor | backend | 2.7.2 → 2.7.2 | 2025-08-03 | DefinitelyTyped | KEEP | Low |
| @types/qrcode | backend | 1.5.6 → 1.5.6 | 2025-10-24 | DefinitelyTyped | KEEP | Low |
| @types/s3rver | backend | 3.7.4 → 3.7.4 | 2025-08-03 | DefinitelyTyped | KEEP (fate tied to s3rver) | Low |
| @types/sanitize-html | backend | 2.16.1 → 2.16.1 | 2026-03-06 | DefinitelyTyped | KEEP | Low |
| @types/semver | backend | 7.8.0 → 7.8.0 | 2026-08-02 | DefinitelyTyped | KEEP | Low |
| @types/ssh2 | backend | 1.15.5 → 1.15.6 | 2026-09-02 | DefinitelyTyped | KEEP | Low |
| @types/ssh2-sftp-client | backend | 9.0.6 → 9.0.6 | 2025-11-30 | DefinitelyTyped | KEEP-WATCH (3 majors behind runtime) | Low |
| @types/ws | backend | 8.18.1 → 8.18.1 | 2025-08-03 | DefinitelyTyped | KEEP | Low |

No package in this group has an install, preinstall or postinstall script (checked with `npm view <pkg> scripts.*`). The native
tools (typescript 7, oxlint, oxfmt, sass-embedded, rolldown) ship prebuilt per-platform binaries as optional dependencies, not
install-time downloads.

### typescript
- **Use:** `npm run typecheck` (`tsc`, `noEmit`) in backend; the CI gate runs it (`quality.yml`).
- **Health:** 7.0.2 is `latest` (released 2026-07-08); `next` gets nightly builds (7.1.0-dev.20260913.1). About 203M dl/wk. Seven npm
  maintainers, all Microsoft accounts or TS team members. `microsoft/typescript-go` is **archived** and describes itself as a "Staging
  repo for development of native port of TypeScript"; `microsoft/TypeScript` was pushed 2026-09-14. That fits the native port having
  moved into the main repo (inferred). The package pulls in 20 `@typescript/typescript-<platform>` binary packages and has no install
  scripts. No GitHub advisories.
- **Alternatives:** none worth considering. tsc is the reference type checker, and oxlint's type-aware mode (`oxlint-tsgolint`
  peer) builds on it rather than replacing it.
- **Shakiness:** none.
- **Verdict:** KEEP. Current, Microsoft-backed, and the whole backend design assumes it.

### oxlint
- **Use:** `npx oxlint --deny-warnings` in all three workspaces (quality.yml lines 174, 271, 302).
- **Health:** 1.82.0 is latest; 13 stable releases since 2026-06-13, roughly weekly. 15.9M dl/wk. The `oxc-project/oxc` repo is
  active (pushed 2026-09-14, 22.7k★) and its top contributors are Boshen (4572), overlookmotel (4007) and camc314 (2198), so
  development is not single-person. The npm publisher is `boshen` alone. VoidZero backs the project. No advisories.
- **Alternatives:** ESLint 9 or Biome. The project already chose against them on purpose, and there is no evidence that choice
  should change.
- **Shakiness:** the only risk is CI breakage on a bump (new rules or warnings under `--deny-warnings`), and the existing
  bump-plus-relint checklist already covers it. Being 3 minors behind is ordinary Dependabot lag.
- **Verdict:** KEEP. Post-1.0, very actively developed, and backed by VoidZero.

### oxfmt
- **Use:** the repo-wide `npx --prefix backend oxfmt --check backend frontend blocks` gate (quality.yml line 339). Only backend
  installs it; frontend does not (see the finding below).
- **Health:** **Pre-1.0.** It is at 0.67.0; the first publish was 2025-09-10, and the oxc blog announced the **beta** on
  2026-02-24. That post names "Stability" as a roadmap goal but gives **no 1.0 date, output-stability guarantee or breaking-change
  policy**. Releases are very frequent: 13 since 2026-06-13 and 65 in the past year. 10.7M dl/wk. The 0.67.0 publish carries an
  SLSA provenance attestation (verified). Upstream claims 100% of Prettier's JS/TS conformance tests pass (vendor claim). No
  advisories.
- **Evidence of unstable output:** this repo's own history records the 0.62→0.64 bump
  breaking already-formatted Vue SFCs. Every minor bump should be expected to possibly reformat code.
- **Alternatives:** Prettier 3.9.6 (published 2026-07-21) is mature and has stable output, but it is far slower. Biome 2.5.13
  (2026-09-10) is post-1.0. Either would be a deliberate policy reversal, and the existing process fix already contains the risk.
- **Shakiness:** the risk is CI and review noise, not supply chain.
- **Verdict:** KEEP-WATCH. Keep the exact pin, and bump only in a dedicated "bump + full reformat" commit rather than taking each
  weekly Dependabot PR (0.64 → 0.67 is already 3 behind). Re-evaluate when 1.0 ships.
- **Finding:** `frontend/package.json` does **not** list oxfmt, even though the task brief assumed backend and frontend. Backend is
  the sole installer, which matches CLAUDE.md. Good: only one copy to bump.

### nodemon
- **Use:** only `npm run dev` → `nodemon backend --watch backend --ext js,ts,json`. There is no nodemon.json or `nodemonConfig`.
- **Health:** 3.1.14 is latest (2026-02-20). No release since, and 4 in the past year. 9.7M dl/wk. The repo is not archived (pushed
  2026-09-12, 13 open issues). It is effectively single-maintainer: remy has 1202 contributions and the next contributor has 16. It
  still depends on `chokidar ^3` (current chokidar is 5). No advisories.
- **Alternative (Node 26 built-in):** `node --watch` / `--watch-path`, stable since v22.0.0/v20.13.0. The v26.8.1 docs show three
  gaps:
  - `--watch-path` "is only supported on macOS and Windows. An `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` exception will be thrown" on
    other platforms. The devcontainer and CI run Linux. Whether that doc line is stale is unverified.
  - Plain `--watch` (without `--watch-path`) watches only the entry point plus its imported modules. It would miss files the backend
    reads through `fs` (`definition.yml`, `locales/*.json`, etc.), which `--ext js,ts,json` does catch today for `.json`.
  - There is no extension filter and no ignore list.
- **Signal nuance:** nodemon's default restart signal is `SIGUSR2` (`lib/config/defaults.js`). The backend's graceful-shutdown set
  is `SIGINT`, `SIGTERM` and `SIGHUP` (`core/http/server.ts:255`), so a nodemon restart may not shut down gracefully, while
  `node --watch` sends SIGTERM by default. The observed dev behaviour is unverified. Either way, `--signal SIGTERM` on the nodemon
  command line would align it.
- **Shakiness:** low. It is dev-only, mature, and needs no config. A watcher is also not worth building in-house.
- **Verdict:** KEEP-WATCH. `node --watch` cannot yet replicate "restart on any backend file, Linux included". Revisit if Node lifts
  the `--watch-path` platform restriction, or if nodemon goes unmaintained.

### npm-check-updates
- **Use:** only the `ncu` (`ncu -i`) and `ncu-u` scripts, in three workspaces. CI, scripts/ and the devcontainer never call it.
- **Health:** 23.1.0 is latest (2026-08-23); 46 releases in the past year. 564k dl/wk. raineorshine has 2002 contributions, the
  runtime package has zero dependencies (bundled), and the repo is active. No advisories.
- **Redundancy:** `.github/dependabot.yml` already opens weekly npm update PRs for backend, frontend, blocks and e2e. At about 46
  releases a year across 3 manifests, ncu also generates much of the Dependabot PR noise itself.
- **Alternatives:** Dependabot (already configured), built-in `npm outdated`, or on-demand `npx npm-check-updates@23 -i`, which
  needs no devDependency.
- **Verdict:** REMOVE. It duplicates Dependabot, runs by hand only, and costs 3 pins to keep current. Change the `ncu` scripts to
  `npx npm-check-updates@<ver> -i` and update the docs that mention it.

### vite
- **Use:** frontend dev server and `vite build` into `../assets`. It also comes in transitively through vitest in blocks (blocks has
  vite 8.2.2 and rolldown 1.2.5 installed today).
- **Health:** 8.3.0 is latest (2026-09-10); 11 stable releases since June. 132M dl/wk. Published by `vitebot@voidzero.dev` and Evan
  You. Of the recent GHSAs, the newest (GHSA-fx2h-pf6j-xcff high, GHSA-v6wh-96g9-6wx3 medium, 2026-06-15) affect only
  `>=8.0.0 <=8.0.15`, so **8.2.2 is not affected**.
- **Alternatives:** none needed. Vite 8's Rolldown core is itself the modern path.
- **Verdict:** KEEP. Take 8.3.0 through Dependabot. Vite has a regular stream of dev-server advisories, so don't let it drift far.

### @vitejs/plugin-vue
- **Use:** SFC compilation in `vite.config.js` and `vitest.config.js`.
- **Health:** 6.0.8 is latest (2026-07-21); peer `vite ^5–^8`; maintained by the Vite/Vue core team (yyx990803, sxzz, vitebot). No
  advisories.
- **Verdict:** KEEP. It is the only official Vue plugin for Vite.

### vite-plugin-vue-devtools
- **Use:** added unconditionally to `vite.config.js` plugins; it is not in `vitest.config.js`.
- **Health:** 8.2.1 is latest (2026-07-25); the repo is `vuejs/devtools` (pushed 2026-09-14, 241 open issues). The single npm
  publisher is `webfansplz`, a Vue devtools core maintainer. 898k dl/wk. It pulls in `vite-plugin-inspect` and
  `vite-plugin-vue-inspector`. No advisories.
- **Shakiness:** it only adds supply-chain surface for a dev convenience. Whether it is `apply: 'serve'`-only, so absent from
  production output, is unverified. That is worth a one-line check.
- **Verdict:** KEEP. It is the official Vue org tool; if the team doesn't use it, dropping it is a cheap way to trim the dependency
  tree.

### vitest
- **Use:** unit test runner for frontend (happy-dom) and blocks (jsdom), plus the flaky-lane configs.
- **Health:** 5.0.0 was released 2026-09-03, and a `V4` dist-tag (4.1.11) still exists for a maintained v4 line. 35 stable releases in
  the past year. 77M dl/wk. Five npm maintainers, including Evan You and antfu.
  - Advisory **GHSA-82fw-gwwq-j7x9** (medium, 2026-09-08, path traversal / arbitrary file read through the `@vitest/mocker`
    redirect mock) affects `<4.1.11`. **4.1.11 is exactly the first patched v4 release**, so do not downgrade.
  - Older criticals (GHSA-5xrq-8626-4rwp, `<4.1.0`) do not apply.
- **v5 migration notes** (vitest.dev blog plus secondary write-ups; details unverified):
  - Automatic `vi.clearAllMocks()` before every test.
  - Config files are no longer looked up in ancestor directories.
  - Node >= 22.12 and Vite >= 6.4 required (both met: engines `^22.12 || ^24 || >=26`, peer vite `^6.4 || ^7 || ^8`).
  - `vitest list` now parses statically.
  - Auto mock clearing may change results in suites that count `mock.calls` across tests.
- **Alternatives:** none needed. On Node 26, backend already uses `node:test`, but the frontend and blocks suites rely on Vite
  transforms (SFC, Tailwind, SCSS).
- **Verdict:** KEEP-WATCH. Plan a deliberate v5 upgrade across frontend and blocks together in one work package, and until then track
  v4 patch releases.

### @vue/test-utils
- **Use:** component mounting through the `frontend/test/mount.js` harness.
- **Health:** 2.5.0 is latest (2026-08-27; the previous release, 2.4.11, came out 2026-06-04). Maintainers are lmiller1990, yyx990803
  and danielroe; the repo was pushed 2026-09-11 and has 32 open issues. 3.4M dl/wk. No advisories. It depends on `js-beautify`.
- **Alternatives:** `vitest-browser-vue` with Vitest browser mode (unverified maturity). That would be a strategy change, not a
  dependency swap.
- **Verdict:** KEEP. It is the official library and still actively maintained, even if releases are slow.

### happy-dom
- **Use:** frontend Vitest environment.
- **Health:** 20.14.5 is latest (2026-09-12). Churn is extreme: 31 releases since 2026-06-13 and 90 in the past year. 12.2M dl/wk. It
  is **effectively a single-maintainer project**: capricorn86 has 1770 contributions and the next contributor has 79. The npm
  publisher is `davidortner` alone. 438 open issues.
- **Advisory history:** five GHSAs, three of them critical. GHSA-96g7-g7g9-jxw8 (<15.10.2), GHSA-37j7-fg3j-429f (<20.0.0) and
  GHSA-qpm2-6cq5-7pq5 (19.x–<20.0.2) are critical; GHSA-6q6h-j7hj-3r64 (<=20.8.7) and GHSA-w4gp-fjgq-3q4g (<20.8.9, 2026-03-29) are
  high. **20.11.6 is not affected** by any of them.
- **Alternatives:**
  - jsdom, which blocks already uses. It has 6 maintainers, 72M dl/wk and one low-severity advisory in 2022. It is slower, and
    moving would mean re-baselining about 1,000+ frontend tests (count unverified).
  - Vitest browser mode with `@vitest/browser-playwright`. Playwright Chromium is already installed in CI for the real-layout suites.
- **Shakiness:** the risk is a test environment executing untrusted content, which is low for our own tests, plus the bus factor.
  It is far too large to bring in-house.
- **Verdict:** KEEP-WATCH. Monitor its advisories and the maintainer count. If a future advisory is slow to patch, the fallback is to
  consolidate onto jsdom, matching blocks.

### jsdom
- **Use:** blocks Vitest environment, chosen deliberately for shadow DOM coverage.
- **Health:** 30.0.1 is latest (2026-07-29); 15 releases in the past year. Six npm maintainers, including domenic. 21.7k★; the repo was
  pushed 2026-09-12. 72.7M dl/wk. The only advisory is from 2022 (<=16.4.0).
- **Verdict:** KEEP. It is the most reputable DOM emulator available.

### playwright (frontend) and @playwright/test (e2e)
- **Use:**
  - `frontend/test/realGridLayout.js` (real Chromium CSS-grid layout checks) and `frontend/scripts/generate-favicon.mjs`.
  - `e2e/` runs the full Playwright suite.
  - CI installs Chromium with `npx playwright install --with-deps chromium`.
- **Health:** 1.63.0 of both was published 2026-09-13. Microsoft-owned, 96k★; 69M and 46M dl/wk. The only advisory,
  GHSA-7mvr-c777-76hp (<1.55.1), does not apply.
- **Note:** both are pinned to 1.62.1. Keep the two in **lockstep**, since a mismatch means two browser builds to download and
  cache.
- **Verdict:** KEEP, both. They are the industry standard for this layer. Bump them together.

### sass
- **Use:** SCSS compilation through Vite. The injected `additionalData` `@use`s `_theme.scss` and `_palette.scss` into every SFC.
- **Footprint** (grep of `frontend/src`):
  - 9 `.scss` files, about 4,050 lines, with `_page-contents.scss` alone at 2,962.
  - 132 `lang="scss"` style blocks across 111 files, and 44 `.vue` files that reference `$variables`.
  - Sass-only constructs: 17 `@use`, 3 `@include`, 1 `@mixin`, 1 `darken()`, 1 `lighten()`, 3 `rgba($…)`.
  - Most of the Sass dependency is plain `$variable` substitution, which CSS custom properties can replace.
- **Health:** 1.104.1 is latest (2026-09-12); 29 releases in the past year. Published by nex3 and hcatlin. 22.3M dl/wk. The
  dart-sass repo is active. No advisories. Its dependencies are `chokidar ^5`, `immutable` and `source-map-js`, plus
  `@parcel/watcher` as an optional native dependency.
- **Tailwind 4 position** (tailwindcss.com/docs/compatibility, quoted): "Tailwind CSS v4.0 … is not designed to be used with CSS
  preprocessors like Sass, Less, or Stylus". It also recommends avoiding `<style>` blocks in favour of utilities, or using globally
  defined CSS variables.
- **Alternatives:**
  1. **sass-embedded** 1.104.1: same release train, published by nex3, 4.2M dl/wk. The Vite 8.3 docs list
     `npm add -D sass-embedded # or sass`. It runs the native Dart compiler, so builds are faster (magnitude unverified). It pulls in
     18 platform binaries plus `rxjs` and `@bufbuild/protobuf`, so the dependency tree is *larger*, not smaller.
  2. **Native CSS:** nesting plus custom properties (the Cobalt token layer in `tailwind.css` already exists), which removes the
     preprocessor entirely.
- **Verdict:** CONSIDER-ALTERNATIVE, long-term. Migrate the `$variable` uses onto the existing CSS custom-property tokens, then
  convert the last handful of mixins and color functions and drop sass. This is a multi-work-package effort, not a dependency swap.
  Switch to sass-embedded only if build time becomes a complaint.

### cross-env
- **Use:** one script, `frontend` `build`:
  `cross-env NODE_ENV=production NODE_OPTIONS=--max-old-space-size=8192 vite build --emptyOutDir`.
- **Health:** 10.1.0 (2025-09-29) is the last release. The GitHub repo is **archived** (verified), and its README says "cross-env is
  'done' … there's no need for new features". It is not marked deprecated on npm. 18.2M dl/wk. It depends on `cross-spawn` and
  `@epic-web/invariant`.
- **Alternative:** `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build --emptyOutDir`. It is cross-platform, and the
  bin path `vite/bin/vite.js` was checked on disk. `vite build` already defaults to `mode: production`; whether it also sets
  `process.env.NODE_ENV=production` when unset is unverified, so pass `--mode production` explicitly or confirm before removing. The
  repo does care about Windows builds (the rollup config has fixes for OpenProject #1109).
- **Shakiness:** it is archived. It will likely keep working, but it will never get fixes.
- **Verdict:** REMOVE. One call site, a zero-dependency replacement, and an archived upstream.

### rollup
- **Use:** `blocks/` build (`rollup -c`). Besides bundling, it runs 3 custom plugins (`blocksManifest`, `blockAssets`,
  `cssAsString`) using `transform`, `buildStart`, `generateBundle`, `emitFile`, `addWatchFile`, `this.parse` and `this.error`.
  `scripts/check-locale-keys.mjs` imports `parseAst` from `rollup/parseAst`.
- **Health:** 4.63.2 is latest (2026-09-12); maintained by the Rollup team (lukastaegert and others); 91M dl/wk.
  - GHSA-mw96-cpmx-2vgc (high, affects <4.59.0) does not apply to 4.62.5.
  - GHSA-gcx4-mw62-g8wm (high, 2024) does not apply either.
- **Alternative: Rolldown**, the bundler inside Vite 8.
  - rolldown 1.2.8 (2026-09-09); published by VoidZero (`rolldownbot@voidzero.dev`, yyx990803, sapphi-red); 68M dl/wk; no advisories.
  - **Already installed in `blocks/node_modules`** (1.2.5, through vitest → vite 8).
  - Its docs and troubleshooting page say CommonJS interop and Node resolution are built in, replacing
    `@rollup/plugin-commonjs`/`-node-resolve`.
  - Terser is replaced by `output.minify` (the Oxc minifier), which the troubleshooting page calls "still a work in progress" (the
    page's current wording is unverified).
  - It offers a Rollup-compatible plugin API and exports `rolldown/parseAst` (verified in package `exports`).
- **Migration cost:** small to medium.
  - Map `resolve({ exportConditions: ['production'] })` to Rolldown's resolve condition option (option name unverified).
  - Confirm `this.parse` and the other hooks the custom plugins use behave the same.
  - Point `check-locale-keys.mjs` at `rolldown/parseAst`.
  - Diff `compiled/` output and `blocks.manifest.json` against the current build. Terser's `ecma: 2019` output versus Oxc minify
    output must be browser-checked.
  - The payoff: 5 devDependencies removed (rollup, 3 `@rollup/plugin-*`, summary) and one bundler shared with frontend.
- **Verdict:** CONSIDER-ALTERNATIVE (rolldown). Nothing is wrong with rollup; the win is consolidation. Worth a spike work package,
  not an urgent change.

### @rollup/plugin-commonjs, @rollup/plugin-node-resolve, @rollup/plugin-terser
- **Use:** CommonJS interop for UMD libraries (e.g. dayjs via mermaid), production-condition resolution for Lit, and minification
  with `ecma: 2019, module: true`.
- **Health:** all three live in `rollup/plugins` (maintainers shellscape, rich_harris, guybedford, lukastaegert; the repo was last
  pushed 2026-05-29, so it is slow-moving). Downloads: commonjs 29.0.3 (2026-05-29) 15.9M/wk; node-resolve 16.0.3 (2025-10-13)
  13.7M/wk; terser 1.0.0 6.5M/wk. None has a GHSA.
- **Is terser plugin 1.0.0 real?** Yes. It was published 2026-03-05 by the rollup/plugins maintainers with an SLSA provenance
  attestation (verified via `dist.attestations`). Its changelog entry is "terser!: upgrade serialize-javascript to v7 and node to v20"
  (breaking only in its engine and dependency requirements). It is the first release since 0.4.4 (2023-10-05), and it is `latest`.
- **Verdict:** KEEP all three as long as blocks stays on rollup. Rolldown's built-ins would make all three unnecessary.

### rollup-plugin-summary
- **Use:** `summary()` prints a size table after each blocks build. It is purely cosmetic; nothing consumes the output.
- **Health:** 3.0.1 (2025-04-08) is the last release; none in the past 12 months. **Single maintainer** (yousifalraheem has 121
  commits; the rest are dependabot). 16★, 13 open issues. The repo was pushed 2026-06-15 without a release. 8.9k dl/wk. No advisories.
- **Packaging smell:** its runtime dependencies include `@eslint/eslintrc`, `@eslint/js` and `globals`, i.e. lint config shipped as
  runtime dependencies. That drags in ajv 6, espree, js-yaml 4, minimatch 3 and more, on top of `terser`, `brotli-size`, `gzip-size`,
  `filesize` and `cli-table3`, which adds up to roughly 30 transitive packages for a size printout (per `npm ls` in blocks).
- **In-house option:** about 25 lines. A `generateBundle(_, bundle)` plugin that computes `Buffer.byteLength`, `zlib.gzipSync` and
  `zlib.brotliCompressSync` per chunk and prints them with `console.table` needs zero dependencies.
- **Verdict:** IN-HOUSE-CANDIDATE, or simply delete it. The supply-chain surface is out of proportion to what it does.

### @types/* (backend devDependencies)
Checked with `tsc --listFiles` in backend: it shows which declaration packages are actually loaded. `tsconfig` has
`"types": ["node"]`, so the other `@types` packages load only through import resolution.

- **@types/js-yaml 4.0.9 → REMOVE.** js-yaml 5.3.0, which backend, frontend and blocks all pin, ships its own types
  (`exports["."].types: ./dist/js-yaml.d.ts`), and `tsc --listFiles` loads `js-yaml/dist/js-yaml.d.ts` and **never** `@types/js-yaml`.
  The `@types` package is also a major behind (4.x, last modified 2025-08-03).
- **@types/nodemailer 8.0.1 → KEEP-WATCH.**
  - It is loaded (14 files) and is the only typing available for runtime **9.0.5**, which ships no `types` field. DefinitelyTyped has
    no 9.x, so there is a major mismatch today.
  - **nodemailer 10.0.0 (2026-09-04) ships its own types** (`types: ./dist/cjs/nodemailer.d.ts`). When the runtime package moves to
    10, remove `@types/nodemailer` in the same commit. The runtime bump is another group's call.
- **@types/ssh2-sftp-client 9.0.6 → KEEP-WATCH.**
  - It is loaded, but the runtime is **12.1.1**: majors 10 (2024-01), 11 (2024-08) and 12 (2025-03) have no matching DefinitelyTyped
    types.
  - The backend only uses `connect`, `end`, `put`, `exists`, `mkdir` and `delete`, across 7 files, all of which predate v10.
  - A ~20-line local `types/ssh2-sftp-client.d.ts` for exactly those methods would be a sensible fallback if DefinitelyTyped goes on
    lagging or the 12.x signatures diverge (not verified).
- **@types/node 26.2.0 → 26.5.1: KEEP.** It tracks the Node 26 major; CI runs 26.8.1. Take patch bumps.
- **@types/pg 8.23.1 (runtime pg 8.23.0, no bundled types): KEEP.** It is loaded and tracks the runtime.
- **@types/pg-cursor 2.7.2 (runtime 2.22.0, no bundled types): KEEP.** It is loaded, has a single consumer, and the minor drift is
  harmless for how it is used (unverified).
- **@types/markdown-it-emoji 3.0.1 (runtime 3.1.0, no bundled types): KEEP.**
- **@types/qrcode 1.5.6 (runtime 1.5.4): KEEP.**
- **@types/sanitize-html 2.16.1 (runtime 2.17.7): KEEP.**
- **@types/semver 7.8.0 (runtime 7.8.5): KEEP.**
- **@types/ssh2 1.15.5 → 1.15.6 (runtime 1.17.0): KEEP.**
- **@types/ws 8.18.1 (runtime 8.21.3): KEEP.**
- **@types/s3rver 3.7.4: KEEP.** Its fate is tied to the runtime `s3rver` 3.7.1, **last published 2022-06-26**, which belongs to
  another group's review. If s3rver is replaced, delete these types with it.
- Health for all of the above: DefinitelyTyped (51k★, pushed 2026-09-14), no install scripts, no advisories. The risk is type drift,
  not security.
- `@types/qs`, `@types/sinon` and `@types/sinonjs__fake-timers` also load, but transitively. They are not direct dependencies and are
  out of scope.

### Group findings
1. **Remove dead or redundant devDependencies.**
   - `@types/js-yaml`: tsc provably doesn't load it.
   - `cross-env`: archived upstream and a single call site; use `node --max-old-space-size=8192 node_modules/vite/bin/vite.js build`
     after confirming NODE_ENV handling.
   - `npm-check-updates` ×3: Dependabot already covers all 4 workspaces; use `npx npm-check-updates@<ver> -i` on demand.
2. **Replace `rollup-plugin-summary`** with a ~25-line in-house `generateBundle` size table, or drop it. A single-maintainer plugin
   with no release in over a year and about 30 transitive dependencies (ESLint config among them) is too much for cosmetic output.
3. **Spike Rolldown for blocks/.** It is already in `blocks/node_modules` through vitest → vite 8, and it has built-in resolve and
   commonjs, `output.minify` and `rolldown/parseAst`. The move would drop rollup plus 4 plugins and put blocks on the same bundler
   as frontend. The main verification cost is diffing `compiled/` and the manifest, plus checking minifier output in a browser.
4. **Manage the two unstable-by-design tools deliberately.**
   - **oxfmt:** pre-1.0 beta with no output-stability promise and roughly weekly releases. Batch its bumps into "bump + full
     reformat" commits instead of weekly Dependabot PRs.
   - **Vitest 5:** plan the upgrade as one frontend + blocks work package (auto `clearAllMocks`, no ancestor config lookup). Stay at
     >=4.1.11 until then, since that is the patched floor for GHSA-82fw-gwwq-j7x9.
5. **Watch list.**
   - **happy-dom:** single maintainer, 3 critical advisories since 2024, extreme churn. The fallback is consolidating onto jsdom.
   - **@types/nodemailer:** delete it when nodemailer reaches 10, which bundles its own types.
   - **@types/ssh2-sftp-client:** 3 majors behind; a local shim is the fallback.
   - **sass:** Tailwind 4 officially discourages preprocessors, and roughly 132 SCSS blocks remain, mostly `$variable` use. Migrating
     to CSS custom properties is a long-term cleanup, not urgent.
   - **nodemon:** stays, because Node 26 documents `--watch-path` as macOS/Windows-only. Consider `--signal SIGTERM` so dev restarts
     go through the graceful-shutdown path.

---

## F. Backend optionalDependencies

Checked live on 2026-09-13 with `npm view`, `npm ls` and `npm audit` in `backend/`. These two ship in production images as optional installs, and every call site already tolerates their absence (`helpers/puppeteer.ts`, `helpers/images.ts` use a dynamic `import(specifier)`).

| Package | Workspace(s) | Pinned → Latest | Last publish | Maintainers/backing | Verdict | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| puppeteer | backend (optional) | 25.4.0 → 25.10.0 | 2026-09-03 | Google Chrome team (`google-wombot` + 1) | KEEP (bump) | Low |
| sharp | backend (optional) | 0.35.3 → 0.35.4 | 2026-08-26 | 1 person (lovell) | KEEP-WATCH (**bump now**) | Med |

### puppeteer
- **Use:** headless Chromium for `models/renderQueue.ts`, `models/pdfExport.ts`, `models/diagramRender.ts`, `api/pages/read.ts` and `migration/bootstrap.ts`, all behind `helpers/puppeteer.ts` (`isPuppeteerAvailable`, `assertPuppeteerAvailable` → 503). The Dockerfile carries Chromium sandbox handling for it.
- **Health:** published by Google's release bot, Apache-2.0, very active (25.10.0 on 2026-09-03). It has an install script: it downloads a browser at install time, which is the only notable supply-chain surface.
- **Alternatives:** `playwright-core` (Microsoft) drives Chromium with a similar API. The repo already uses Playwright for tests, so consolidating onto one browser-automation library is possible but offers no health gain. Puppeteer is Google-backed and tracks Chrome directly.
- **Verdict: KEEP.** Bump to 25.10.0 so the downloaded Chromium picks up recent browser security fixes; render input is author-controlled page content.

### sharp
- **Use:** image processing in `helpers/images.ts` (3 dynamic-import sites: thumbnails and format conversion), with graceful degradation when the optional install is skipped.
- **Health:** one maintainer (lovell), but the de facto standard Node image library, Apache-2.0, bundling prebuilt libvips binaries. It has an install script.
- **Advisories (from `npm audit`):** the top-level `sharp` 0.35.3 is inside GHSA-rgj7-g3m4-5g8c (`< 0.35.4`, inherited libvips/libheif CVEs, **high**). A second, older copy (`0.32.6`) is nested under `@xenova/transformers` and is also inside GHSA-f88m-g3jw-g9cj (`< 0.35.0`). Uploaded images are untrusted input, so libvips CVEs matter here.
- **Alternatives:** none of comparable quality. `jimp` is pure JS and far slower; `@napi-rs/image` is single-maintainer and less adopted. In-house image decoding is out of the question.
- **Verdict: KEEP-WATCH.** Bump to 0.35.4 now. The nested 0.32.6 goes away with the `@xenova/transformers` → `@huggingface/transformers` replacement (section B), though that successor's `sharp ^0.34.5` range may still pull a vulnerable copy until it widens. Check with `npm ls sharp` after the swap.

---

