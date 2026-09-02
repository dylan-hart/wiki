import { mapAuthenticationRows } from '../mappers/authentication.ts'
import { mapSiteSettings } from '../mappers/site-settings.ts'
import { mapStorageRows } from '../mappers/storage.ts'
import { definePhase } from './define-phase.ts'
import type { AuthModuleResolver, SourceAuthenticationRow } from '../mappers/authentication.ts'
import type { SiteSettingsSourceRow } from '../mappers/site-settings.ts'
import type { SourceStorageRow, StorageModuleResolver } from '../mappers/storage.ts'
import type { MigrationContext } from '../context.ts'
import type { WriteRecorder } from '../recorder.ts'

/**
 * Routes `ctx.source.settings()`'s tagged rows (`PostgresSourceConnector.settings()`,
 * yielding `{ entity: 'settings' | 'authentication' | 'storage', ...row }` in that strict order) to
 * the three pure mappers (Tasks 764/765/767 — `mapSiteSettings`/`mapAuthenticationRows`/
 * `mapStorageRows`) and applies each mapper's output against the real destination.
 *
 * ## Why this drains the source itself, rather than classifying per tagged row
 *
 * `mapSiteSettings` needs every `settings`-tagged row available at once (it builds one patch from the
 * whole `settings` table, not a per-row patch), and `mapAuthenticationRows`/`mapStorageRows` both take
 * an array/iterable up front too — none of the three mappers has a per-record streaming API this
 * phase could drive one tagged row at a time. So this function does its own full `for await` over
 * `ctx.source.settings()`, bucketing every row by its `entity` tag, and is called exactly once per
 * phase run — see `settingsPhase` below for the closure-scoped guard that enforces that against
 * `define-phase.ts#readEntity()`'s per-record `classify` contract.
 *
 * ## Resolver classification touches `WIKI` unconditionally, unlike this phase's writes
 *
 * `phases/content.ts`/`phases/users.ts` both keep a `dryRun` run fully `WIKI`/db-free (their
 * classification logic runs through an injected writer that has its own no-op dry-run
 * implementation). That split isn't available here: `mapAuthenticationRows`/`mapStorageRows` need a
 * real `AuthModuleResolver`/`StorageModuleResolver` — `resolver.getModule()`/`getDefinition()` is
 * what tells a row `created`/`updated` apart from `unsupported` in the first place, not just how it's
 * written — and the real resolvers are `WIKI.models.authentication`/`WIKI.models.storage` themselves.
 * Both models' `getModule`/`getDefinition`/`buildConfig`/`validateConfig` only ever read
 * `WIKI.data.authentication`/`WIKI.models.storage.definitions` (populated once from disk by
 * `refreshStrategiesFromDisk()`/`refreshFromDisk()` — see `bootstrap.ts`), never `WIKI.db`, so this is
 * cheap and read-only, but it does mean a pure unit test of this phase's real classification (as
 * `phases.test.ts` has for `usersPhase`/`contentPhase`) isn't possible without a live `WIKI` global —
 * covered instead by `phases/settings.integration.test.ts`'s real `setupTestDb()` destination.
 *
 * The one destination *read* this function makes outside a `recorder.create()` write callback —
 * `WIKI.models.storage.getSiteTargets(ctx.siteId)`, to find the row a storage update applies to — is
 * for the same reason: deciding `wouldCreate` vs. `conflict` for a storage row requires knowing
 * whether the row a mapped update targets actually exists, and that decision has to happen before
 * calling exactly one recorder method (never both — see the storage loop below), the same "compute
 * the real outcome, then report it once" rule `phases/route.ts#routeOutcome()` establishes for every
 * phase. Doing this unconditionally rather than gating it
 * behind `ctx.dryRun` (as `phases/content.ts#existingEntry` does) matches what that file's own doc
 * comment says a real CLI run could safely do anyway ("the destination db is always live even under
 * --dry-run, so checking the real tree ... is both possible and correct there") — content.ts chose the
 * gate only to keep its own pure-unit tests `WIKI`-free, which this phase's tests cannot be regardless.
 */
async function runSettingsImport(ctx: MigrationContext, recorder: WriteRecorder): Promise<void> {
  const settingsRows: SiteSettingsSourceRow[] = []
  const authRows: SourceAuthenticationRow[] = []
  const storageRows: SourceStorageRow[] = []

  for await (const record of ctx.source.settings()) {
    const tagged = record as { entity: 'settings' | 'authentication' | 'storage' }
    if (tagged.entity === 'settings') {
      settingsRows.push(record as unknown as SiteSettingsSourceRow)
    } else if (tagged.entity === 'authentication') {
      authRows.push(record as unknown as SourceAuthenticationRow)
    } else if (tagged.entity === 'storage') {
      storageRows.push(record as unknown as SourceStorageRow)
    }
  }

  // -> One sentinel record for the whole site-config/instance-settings patch, mirroring
  //    `phases/content.ts`'s single `site-navigation` sentinel: there is no per-row identity to
  //    report against (the patch is a merge of every `settings`-tagged row at once), so this counts
  //    as exactly one `wouldCreate` regardless of how many source rows fed it, including zero.
  // -> Pure, no-I/O classification — computed unconditionally, the same "compute for real either
  //    way" rule `phases/content.ts`'s `setNavItems` doc comment gives for its own sanitize step,
  //    so a dry run classifies identically to a live one; only the writes below are conditional.
  const { siteConfigPatch, instanceSettings } = mapSiteSettings(settingsRows)
  await recorder.create('site-config', async () => {
    if (Object.keys(siteConfigPatch).length > 0) {
      // -> `updateSite()` merges its own `config` patch onto the row already in the destination
      //    (`models/sites.ts`'s own `mergeWith(current, patch, ...)`), so this is already safe against
      //    the same wholesale-replace hazard `instanceSettings.mail`/`.security` below have to guard
      //    against by hand.
      await WIKI.models.sites.updateSite(ctx.siteId, { config: siteConfigPatch })
    }
    if (instanceSettings.mail) {
      // -> `WIKI.models.settings.updateConfig(key, value)` is a raw `INSERT ... ON CONFLICT DO UPDATE`
      //    that REPLACES the whole `mail` row wholesale — writing `instanceSettings.mail` straight
      //    through it (as an earlier version of this code did) would silently delete every field the
      //    2.x mapper's patch doesn't happen to produce (its own doc comment: `MAIL_FIELDS` has no
      //    `defaultBaseURL`, so a 2.x source with mail configured would delete
      //    `mail.defaultBaseURL` from the destination). The real admin route
      //    (`api/mail.ts`'s PATCH handler) never calls `updateConfig()` directly for exactly this
      //    reason: it shallow-merges the incoming patch onto `WIKI.config.mail` (already the
      //    DB-loaded value — `bootstrap.ts`'s `configSvc.loadFromDb()` runs before any phase does)
      //    and writes the merged whole back via `WIKI.configSvc.saveToDb(['mail'])`. Mirrored here
      //    verbatim rather than reimplemented, so this stays byte-for-byte the same merge the admin
      //    UI's own save button performs.
      const previousMail = WIKI.config.mail
      WIKI.config.mail = { ...previousMail, ...instanceSettings.mail }
      if (!(await WIKI.configSvc.saveToDb(['mail']))) {
        WIKI.config.mail = previousMail
        throw new Error('failed to save mail configuration during migration')
      }
    }
    if (instanceSettings.security) {
      // -> Same wholesale-replace hazard as `mail` above (any 3.0-only `security` field the mapper's
      //    patch doesn't produce — `corsConfig`/`corsMode`/`cspDirectives`/`enforceCsp`/
      //    `hstsDuration`/`uploadScanSVG`/`forceAssetDownload`/... — would be silently deleted). Unlike
      //    `mail`, `security` already has a real model method that does the correct merge-then-save:
      //    `WIKI.models.security.updateConfig(patch)` (`models/security.ts`) does the exact same
      //    `{ ...previous, ...patch }` + `saveToDb(['security'])` `api/mail.ts` does for `mail`, so
      //    this calls it directly instead of hand-rolling the merge a second time.
      const saved = await WIKI.models.security.updateConfig(instanceSettings.security)
      if (!saved) {
        throw new Error('failed to save security configuration during migration')
      }
    }
  })

  // -> `WIKI.models.authentication` satisfies `AuthModuleResolver` structurally: `getModule`,
  //    `buildConfig` and `validateConfig` all match the narrow interface's signatures exactly (see
  //    `mappers/authentication.ts`'s own doc comment on why the interface exists at all).
  const authResolver: AuthModuleResolver = WIKI.models.authentication
  // -> Every created authentication row's `autoEnrollGroups` is silently `[]`, regardless of what
  //    the 2.x source row actually had configured: remapping them needs old-group-id ->
  //    new-group-UUID entries that only exist once the `users` phase has run, but `settings` runs
  //    *before* `users` (`phases/users.ts`'s own `dependsOn: ['settings']`), so that map genuinely
  //    cannot exist yet here. This is the same forced, documented-not-solved reporting gap
  //    `userImporter.providerFallbacks` has in `phases/users.ts`: neither `PhaseResult`
  //    nor `PhaseReport` has a field shaped to surface it. Fixing this for real would mean either
  //    re-ordering the phases (settings currently has `dependsOn: []` specifically so it can run
  //    first — see this phase's own module doc) or a second pass over already-created strategies
  //    after `users` has run — both deliberately out of scope.
  const authResult = await mapAuthenticationRows(authRows, { resolver: authResolver })
  for (const result of authResult.results) {
    switch (result.status) {
      case 'created': {
        const row = result.row!
        await recorder.create(result.sourceKey, () =>
          WIKI.models.authentication
            .createStrategy({
              module: row.module,
              displayName: row.displayName,
              isEnabled: row.isEnabled,
              selfRegistration: row.selfRegistration,
              autoProvision: row.autoProvision,
              allowedEmailRegex: row.allowedEmailRegex,
              autoEnrollGroups: row.autoEnrollGroups ?? undefined,
              config: row.config as Record<string, any>
            })
            .then(() => undefined)
        )
        break
      }
      case 'unsupported':
        // -> Exact semantic match: the source row's module has no matching 3.0 authentication
        //    module at all (`resolver.getModule()` returned null) — see `report.ts`'s doc comment
        //    on this reason, which now explicitly covers this mapper's own `'unsupported'` status
        //    alongside `report.ts#classifyUserAuthProvider`'s pre-existing use of it.
        recorder.unmappable(
          result.sourceKey,
          'unsupported-auth-provider',
          result.message ?? `authentication module '${result.module}' has no 3.0 destination`
        )
        break
      case 'flagged':
        // -> The module exists, but its config could not be safely carried across (no verified
        //    prop-name mapping, or a value that failed validation after remapping) — read but not
        //    written, not an error. Mirrors `phases/users.ts#routeOutcome()`'s precedent: between
        //    the two "not written, not an error" buckets `WriteRecorder` offers, `skipExisting` is
        //    the closer fit, since `conflict()` is reserved for two records genuinely colliding.
        //    `recorder.skipExisting()` itself takes no detail parameter (`report.ts`'s `PhaseReport`
        //    tracks only a count for this bucket, not per-entry detail — the same gap
        //    `wouldSkipExisting`'s own doc comment describes), so `result.message` — which module and
        //    exactly why it wasn't carried across — would otherwise vanish entirely; logged via
        //    `ctx.log?.()`, the same optional progress hook `phases/content.ts` already established
        //    the convention for (its own "navigation item... blanked" warning).
        ctx.log?.(
          `authentication strategy '${result.sourceKey}' (module '${result.module}') not created: ${result.message}`
        )
        recorder.skipExisting(result.sourceKey)
        break
    }
  }

  // -> `WIKI.models.storage` satisfies `StorageModuleResolver` structurally, same reasoning as
  //    `authResolver` above.
  const storageResolver: StorageModuleResolver = WIKI.models.storage
  const storageResult = await mapStorageRows(storageRows, {
    resolver: storageResolver,
    siteId: ctx.siteId
  })
  for (const result of storageResult.results) {
    switch (result.status) {
      case 'updated': {
        const update = result.update!
        const identifier = `${result.sourceKey}@${ctx.siteId}`
        // -> Read before deciding which single recorder method to call — see the module doc
        //    comment's "Resolver classification touches WIKI unconditionally" section for why this
        //    isn't gated behind `ctx.dryRun`, and why it happens outside `recorder.create()`'s own
        //    write callback (nesting a `conflict()` call inside a `create()` that already counted
        //    this record would double-count it against `report.ts`'s
        //    `found === wouldCreate + wouldSkipExisting + conflicts.length + unmappable.length`
        //    invariant).
        const targets = await WIKI.models.storage.getSiteTargets(ctx.siteId)
        const existing = targets.find((t) => t.module === update.module)
        if (!existing) {
          // -> Structurally shouldn't happen: `Sites.createSite()` calls `storage.syncSite()` at
          //    site-creation time, which seeds exactly one row per module definition on disk, and
          //    `mapStorageRow()` only reaches `'updated'` for a module `resolver.getDefinition()`
          //    itself recognizes. Reported as a conflict rather than thrown, so one missing row
          //    (e.g. a target site that predates a module being added) doesn't abort the rest of
          //    this phase's already-good-standing rows.
          recorder.conflict(
            identifier,
            `no existing storage row for module '${update.module}' on site ${ctx.siteId} — ` +
              'Sites.createSite()/Storage.syncSite() should have seeded one at site-creation time'
          )
          break
        }
        // -> `droppedFields` (`mappers/storage.ts`'s own doc comment: "this mapper reports whichever
        //    of the two remain unconverted") is set only when `mode`/`syncInterval` had a real source
        //    value that could not be converted to 3.0's shape — a real, silent loss otherwise, since
        //    nothing in `StorageUpdatePayload` itself carries it through to a write. Logged here
        //    (matching `phases/content.ts`'s `ctx.log?.()` convention for a non-fatal, per-record
        //    warning) rather than dropped, even though the row itself still gets created.
        if (result.droppedFields) {
          ctx.log?.(
            `storage target '${result.sourceKey}@${ctx.siteId}': could not convert ${Object.keys(result.droppedFields).join('/')} to 3.0's shape — left at the destination's existing/default value. Dropped: ${JSON.stringify(result.droppedFields)}`
          )
        }
        await recorder.create(identifier, () =>
          WIKI.models.storage
            .updateTarget(ctx.siteId, existing, {
              id: existing.id,
              isEnabled: update.values.isEnabled,
              config: update.values.config,
              sync: {
                mode: update.values.syncMode,
                scheduleOverride: update.values.scheduleOverride
              }
            })
            .then(() => undefined)
        )
        break
      }
      case 'unsupported':
        recorder.unmappable(
          result.sourceKey,
          'unsupported-storage-module',
          result.message ?? `storage module '${result.module}' has no 3.0 destination`
        )
        break
      case 'flagged':
        // -> Same "not written, not an error" bucket as the authentication mapper's own 'flagged'
        //    status above — a real 3.0 module, but its config failed validation after remapping. See
        //    that case's own comment on why `result.message` is logged rather than silently dropped.
        ctx.log?.(
          `storage target '${result.sourceKey}@${ctx.siteId}' (module '${result.module}') not updated: ${result.message}`
        )
        recorder.skipExisting(result.sourceKey)
        break
    }
  }
}

/**
 * Phase 1 (Feature 420: settings/auth/storage config importer). No dependency — everything else in a
 * 2.x install is read relative to how the destination is configured to store and render it.
 *
 * This phase wires the real mappers/models. Unlike `phases/users.ts`/`phases/content.ts`
 * (several entities, each with its own per-record `classify`), this phase reads exactly one entity —
 * so `runSettingsImport()` above must run exactly once per phase run, not once per tagged row
 * `readEntity()` classifies. A closure-scoped boolean guard is the whole mechanism: no factory/state
 * object is needed the way Tasks 12/14's multi-entity importers use, since there is only ever one
 * entity here to guard.
 *
 * `readEntity()`'s own `count` (raw records read off `ctx.source.settings()`, via the `source`
 * function below) still reports the true number of settings/authentication/storage rows found,
 * independent of how many times `classify` did real work. `runSettingsImport()`'s own internal
 * `recorder.create()`/`unmappable()`/`skipExisting()`/`conflict()` calls (one for `site-config`, one
 * per authentication row, one per storage row) are what actually populate the phase's `PhaseReport`
 * snapshot — this does not need to line up 1:1 with the raw record count, the same as `pageHistory`/
 * `tags` already not lining up 1:1 in the content phase (see `report.ts`'s own doc comment).
 */
export const settingsPhase = definePhase({
  id: 'settings',
  label: 'Settings, authentication & storage config',
  dependsOn: [],
  entities: (ctx) => {
    let started = false
    return {
      settings: {
        source: () => ctx.source.settings(),
        classify: async (_record, recorder) => {
          if (started) {
            return
          }
          started = true
          await runSettingsImport(ctx, recorder)
        }
      }
    }
  }
})
