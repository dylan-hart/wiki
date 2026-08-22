# Air-gapped / offline deployment

Feature [#820](../../../work_packages/820) "Restore 2.5.x's fully-offline deployment mode". This is
the supported air-gapped deployment path end-to-end: what has to be present before first boot, what
`offline: true` actually gates, and how to add or update a locale pack against a running instance with
no network access, rebuild, or redeploy.

## Turning it on

`offline` (`backend/base.yml`, default `false`) is a plain top-level config key, so it follows the
same three sources every other config key does — `config.yml`, merged over `base.yml`'s default,
merged over by the `settings` DB table — **plus**, per the acceptance criterion this feature closes
(upstream [requarks/wiki#2675](https://github.com/requarks/wiki/issues/2675)), two ways to set it
without hand-editing `config.yml`:

- **Environment variable.** The official container image's baked-in config
  (`dev/build/config.yml`) reads `offline: $(WIKI_OFFLINE:false)` — `helpers/config.ts#parseConfigValue`
  substitutes `$(WIKI_OFFLINE:false)` with the `WIKI_OFFLINE` env var (or the `false` default) as raw
  text before the file is YAML-parsed, exactly the same mechanism already used for `DB_HOST`,
  `LOG_LEVEL`, etc. in that file. Set `WIKI_OFFLINE=true` on the container and nothing else needs to
  change.
- **Helm values.** `dev/helm/values.yaml`'s `offline` value (default `false`) is wired straight to
  that same `WIKI_OFFLINE` env var in `templates/deployment.yaml`. Set `offline: true` in your values
  override.

2.5.x's flag was `config.yml`-only, which broke exactly this: a containerized or Helm-provisioned
deployment where nobody hand-edits a file baked into the image. This closes that gap without adding a
second flag or a migration — it is the same `offline` key, just reachable from more places.

## What `offline: true` gates

Every outbound call this instance can make **without an admin having explicitly configured a specific
remote endpoint for it**:

| Call site | What it does when offline | File |
| --- | --- | --- |
| Icon resolution | Skips the Iconify API fetch for an icon not yet cached; the icon just does not resolve until sideloaded via `POST /_api/icons/materialize` with an admin-provided SVG, or its set is pre-seeded. | `models/icons.ts` |
| Daily version check (`checkVersion` job, also the admin "Check for Updates" button) | No-ops with a log line instead of hitting `api.github.com`. | `tasks/simple/check-version.ts` |
| Daily locale sync (`updateLocales` job) | No-ops with a log line instead of hitting `github.com/requarks/wiki-locales`. Use locale **sideloading** (below) instead. | `tasks/simple/update-locales.ts` |
| Server-side PlantUML rendering (`POST /_api/diagrams/render`, used by PDF export and any client asking this instance to draw a diagram itself rather than in-browser) | Refuses with a clear 503 instead of attempting the request — regardless of whether the diagram names the public default server or a custom one, since either is an arbitrary URL taken from request/page content, not something the admin configured for this instance. | `models/diagramRender.ts` |

**Explicitly out of scope**, because an admin turned them on with their own credentials/endpoint —
turning `offline` on does not touch these, and turning it on while any of them are enabled is a
self-contradictory configuration this instance cannot detect for you:

- Authentication strategies that call out (Discord, GitHub, generic OAuth2, CAS) — admin-configured
  per strategy in Admin → Login.
- Search engines other than the built-in `db` (Postgres full-text, always available, never disabled)
  — Algolia, AWS CloudSearch, Azure Search, Elasticsearch.
- Storage targets — git, S3, Azure, GCS, SFTP.
- Installing the Puppeteer or Sharp extensions (`POST /_api/extensions/:key/install`) — an explicit
  admin action that fetches an npm package. See "Server-side diagram/PDF rendering" below for what
  this means for an air-gapped instance that wants Mermaid PDF export.

**Confirmed to need nothing** — audited and already fully local, so nothing was gated because there
was nothing to gate:

- **Avatars.** Stored as bytes in the `userAvatars` table (`models/users.ts`); there has never been a
  Gravatar fetch in this fork. A user with no avatar renders as initials.
- **Fonts.** `frontend/src/css/_base.scss` uses `@font-face` against bundled font files. No
  `fonts.googleapis.com` reference exists anywhere in `frontend/src` or `blocks/`.
- **Icons drawn from the interface itself** (nav, buttons, admin UI). Every Iconify reference written
  literally in this repo's source is inlined at build time into `src/assets/icons.generated.js` — see
  CLAUDE.md's "Icons" section. Only a reference a *user* picks at runtime touches `models/icons.ts`'s
  four-tier resolution above.

**Not gated, and cannot be from the backend** — `block-plantuml` and `block-kroki` (`blocks/`) draw by
setting an `<img src>` pointing at a public server (`plantuml.com`, `kroki.io`) by default, unless the
page names its own `server`. That request is made by the **reader's browser**, not this instance, so
`WIKI.config.offline` has nothing to gate — the wiki server never sees it. On a genuinely air-gapped
network, those diagrams simply will not load unless every page using them names an in-network server
via the block's `server` attribute. This is a content-authoring concern for an air-gapped deployment
to document internally, not a bug this feature could fix.

## Locale-pack sideloading

**Decision: a writeable directory under the data volume, not a DB-only path.** `<dataPath>/locales/`
(default `./data/locales`, alongside the existing `<dataPath>/cache/icons` and `<dataPath>/cache/files`
directories) is scanned for `<code>.json` files, each a **self-contained locale pack**:

```json
{
  "name": "Klingon",
  "nativeName": "tlhIngan Hol",
  "language": "tlh",
  "region": "",
  "script": "",
  "isRTL": false,
  "strings": { "common.actions.save": "chenmoH", "...": "..." }
}
```

Only `name`, `language` and `strings` are required — `nativeName` defaults to `name`, `region`/`script`
default to `''`, `isRTL` defaults to `false`. The file's `<code>` (its filename minus `.json`) becomes
the locale's row in the `locales` table, upserted through exactly the same path
`refreshFromDisk`/`update-locales` already use — this is not a new storage mechanism, it is a third
source feeding the one that already exists:

1. **Vendored** (`backend/locales/*.json`, Localazy-managed, baked into the image) — every language
   `locales/metadata.js` declares.
2. **Network** (`update-locales` task, daily, off by `offline` or `update.locales: false`) — pulls the
   same vendored set fresher than the image, when online.
3. **Sideloaded** (`<dataPath>/locales/*.json`, this feature) — anything an operator drops into the
   data volume, online or offline. Unlike the other two, a sideloaded code needs no entry in
   `locales/metadata.js` — this is how a locale nobody has vendored yet gets **added**, not just
   updated. Files must sit directly in `<dataPath>/locales/` (not nested in a subdirectory) — the scan
   is not recursive.

Why the data volume and not moving locale storage into the DB outright: the strings already live in
the DB (the `locales` table is the runtime source of truth every reader's `/_api/locales/:code/strings`
request reads from — see `models/locales.ts#getStrings`). What 3.0 was missing was only a way to get a
*new or changed* file into that table without a rebuild. A writeable directory an operator can mount,
`kubectl cp` into, or `docker cp` into is exactly that, with no new API surface for the common case of
"I have a JSON file, put it in the running instance."

**Picked up:**

- On every boot (`postBoot()` → `WIKI.models.locales.refreshFromDisk()`, which now also calls
  `sideloadFromDataPath()`).
- On demand, without a restart: `POST /_api/locales/sideload` (requires the `manage:system` global
  permission) rescans the directory and force-reloads every file it finds, returning `{ loaded,
  skipped }` — `skipped` names any file that failed JSON parsing or is missing a required field, so a
  bad drop is visible immediately rather than silently ignored.

**Helm**: `dev/helm/values.yaml`'s `sideload.enabled`/`sideload.repoURL` stanza runs a git-clone
`initContainer` that populates `/wiki/data/locales/` (i.e. `<dataPath>/locales/`) from a git repo of
locale-pack JSON files before the app container starts — for a cluster where "the data volume" means
"whatever the init container populated," not a person with `kubectl cp` access. The init container
shares the chart's `volumeMounts`/`volumes` values with the main container, so a volume actually has
to be mounted there (the same one backing the app's own persistent `<dataPath>`) for the clone to
survive past the init container exiting — set `volumeMounts`/`volumes` alongside `sideload.enabled`,
not just the latter on its own.

## What must be present before first boot

For a fresh instance that will never reach the network:

- **The image itself** — already contains the full vendored locale set, self-hosted fonts, and every
  UI icon reference, per the audit above. No further action needed for base functionality.
- **`config.yml` (or `WIKI_OFFLINE=true` / Helm's `offline: true`)** setting offline mode, so the daily
  version/locale-sync jobs stop attempting network calls instead of failing (harmlessly, but noisily)
  every day.
- **Any locale beyond the vendored set**, pre-populated into `<dataPath>/locales/` before or shortly
  after first boot (see above) — there is no other way to add one offline.
- **Puppeteer, if server-side Mermaid rendering (PDF export with diagrams) is wanted.** The Docker
  image already installs Chromium itself and sets `PUPPETEER_EXECUTABLE_PATH`, but the Puppeteer
  *extension* — the npm package Wiki.js loads to drive it — is not installed into the image by default,
  and installing it through Admin → Utilities fetches it from the npm registry. An air-gapped
  deployment that wants this needs a custom image with `puppeteer` pre-installed into
  `backend/node_modules` (see `dev/build/Dockerfile`'s own comment on why it is not there by default),
  or a private npm registry mirror reachable from inside the air gap.
- **A self-hosted PlantUML/Kroki server, if those diagram types are used at all.** Every page using
  `block-plantuml`/`block-kroki` (or the `POST /_api/diagrams/render` endpoint) needs its own `server`
  attribute pointing at one reachable inside the network — there is no way to make the public default
  work air-gapped, and (per the client-side note above) no way for the backend to enforce this on
  authors' behalf.

## What stays admin-configurable afterward with no network access

Everything not listed above as needing network: creating/editing/publishing pages, users, groups,
permissions, navigation, themes, the built-in `db` search engine, `disk` storage, avatars, icon sets
already fetched or manually materialized, and re-running the locale sideload scan.
