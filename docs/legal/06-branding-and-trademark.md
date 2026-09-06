# Branding and trademark

## Position

- "Wiki.js", the Wiki.js wordmark/logo, "Requarks" and "requarks.io" are upstream's brand
  identifiers. No registration was found by web search; registry databases were **not** checked.
  Unregistered marks still carry common-law protection in most jurisdictions, and the practical
  risk is confusion, not litigation: a reader thinking they are dealing with Requarks, sending a
  security report or a donation to Requarks for this project, or the reverse.
- The AGPL gives the fork **no** right to use those marks. It also does not forbid it; trademark
  law does that on its own terms. Upstream has published no trademark policy that would grant
  broader permission.
- Nominative use is fine: saying "Cardinal is a fork of Wiki.js 3.x" is exactly the kind of
  truthful reference trademark law allows, and it is what AGPL §5(a) wants stated anyway.
- The fork has already made the right top-level decision — a distinct name (Cardinal / Cardinal.js),
  its own mark, its own repository link in the footer. What remains is residue.

## Where "Wiki.js" / Requarks still appear

Grouped by whether a reader outside the project would see it.

### Visible to the public or to operators — fix these

| Location | What it says | Why it matters |
| --- | --- | --- |
| `README.md` top | `<img src="https://static.requarks.io/logo/wikijs-full.svg">` — the Wiki.js logo, hotlinked from Requarks' CDN; badges for GitHub Sponsors `ngpixel` and OpenCollective `wikijs`; "Official Website: beta.js.wiki" | The repository's front page presents as Wiki.js and routes money to upstream. Also, hotlinking a CDN you do not control is fragile. |
| `README.md` badge | AGPLv3 badge links `requarks/wiki/blob/master/LICENSE` | Should link this repo's own `LICENSE`. |
| GitHub repository metadata | Description "Wiki.js \| A modern and powerful wiki app built on Node.js", homepage `https://js.wiki` | Inherited from the fork action. Set in the GitHub repo settings. |
| `.github/FUNDING.yml` | `github: [NGPixel]`, `patreon: requarks`, `open_collective: wikijs` | GitHub shows a "Sponsor" button on the fork that pays Requarks. |
| `.github/SECURITY.md` | "Send an email to security@requarks.io" | Vulnerability reports about the fork go to a party that does not maintain it. |
| `.github/CODE_OF_CONDUCT.md` | Contact `abuse@requarks.io` | Same. |
| `.github/ISSUE_TEMPLATE/config.yml`, `ISSUE_TEMPLATE.md`, `auto_assign.yml` | Links to `Requarks/wiki` discussions, `feedback.js.wiki`, `requests.requarks.io`; auto-assigns `NGPixel` | Issue flow points at upstream. |
| `dev/build/Dockerfile` | `LABEL maintainer="requarks.io"` | Image metadata names the wrong maintainer. |
| `backend/package.json` | `homepage`, `bugs.url`, `repository.url` → `requarks/wiki`; `funding` → `opencollective.com/wikijs`; `description` "The most powerful and extensible open source Wiki software" | npm-style metadata; `funding` in particular is surfaced by `npm fund`. |
| `backend/tasks/simple/check-version.ts` | Fetches `api.github.com/repos/requarks/wiki/releases/latest` | The admin "Check for updates" will report upstream's **2.5.x** release as the latest version of Cardinal. Wrong product, wrong major. |
| `backend/base.yml` `docsBase` | `https://beta.js.wiki/docs` | Every in-app help button opens upstream's docs. (The frontend's `docsBaseGate.test.js` already keeps fork-invented surfaces from carrying one.) |
| `backend/core/http/openapi.ts` | Swagger title "Wiki.js API" | Public at `/_api`. |
| `backend/locales/en.json` (17 strings) | e.g. `welcome.title` "Welcome to Wiki.js!", `admin.dashboard.wikiVersion` "Wiki.js version", `admin.dashboard.contributeSubtitle` "Wiki.js is a free and open source project…", mail subjects "Wiki.js Test Email" / "Wiki.js event: {event}", several `admin.system.*Hint` and `admin.security.*` strings | User-facing. The other ~50 locale files carry 11 each, synced from `requarks/wiki-locales`. |
| `frontend/src/pages/AdminSystem.vue` | Card header literal "Wiki.js"; copied system-info text starts "Wiki.js {version}" | Admin-facing. |
| `frontend/src/helpers/storageDeliveryGraph.js` | Node named "Wiki.js" drawn with `/_assets/logo-wikijs.svg` | Admin-facing; the logo file is still shipped for this. |
| `backend/api/hooks.ts` | Webhook test payload "This is a test event sent by Wiki.js…" | Leaves the instance and reaches third parties. |
| `backend/index.ts` | Boot banner `= Wiki.js 3.0.0 =`; header comment "Wiki.js Server" | Operator logs. |

### Internal identifiers — harmless, rename only if convenient

- PostgreSQL `application_name` values `Wiki.js - <id>:MAIN|WORKER|SCHEDULER|EVENTS|COLLAB`
  (`core/db.ts`, `core/scheduler.ts`, `core/collab.ts`, matched by `api/system/info.ts`'s
  `LIKE 'Wiki.js%'`). Renaming means changing all five in one commit.
- Prometheus metric prefix `wikijs_` (`controllers/metrics.ts`). Renaming breaks dashboards.
- `core/db.ts` messages about "Wiki.js 2.x" databases — those are *correctly* about Wiki.js,
  since they describe the migration source. Keep.
- Comments and tests referencing upstream issues (`requarks/wiki #4631` and the like). Keep; they
  are attribution.
- Package names `wiki-backend`, `wiki-ux`, `blocks`, `wiki-e2e`. Not published to npm; cosmetic.

### The locale-sync trade-off

`update-locales.ts` pulls translations from `requarks/wiki-locales` on a schedule. Those files are
Localazy exports of upstream's `en.json`, so every language says "Wiki.js" wherever the English
does, and any fork-added key has no translation. Renaming the 17 English strings without changing
the sync means the translations keep saying "Wiki.js" in every language but English. The options
are: (a) keep syncing and accept the mismatch, (b) stop syncing and freeze the vendored locales,
(c) run the fork's own Localazy project (`localazy.json` is already in the tree). This is a product
decision, not a legal one; it just needs to be made consciously.

## Recommendation on the name

Keep "Cardinal" as the product name everywhere a user, operator or third party sees it; keep
"Wiki.js" only in the nominative "fork of Wiki.js" sense (README, NOTICE, migration docs) and in
the 2.x-database messages that genuinely refer to Wiki.js. Drop the Wiki.js logo files once
`storageDeliveryGraph.js` is repointed at the Cardinal mark. Do not adopt "Cardinal.js" for any
npm package name without checking the npm registry first (`cardinal` is a long-standing published
package name).
