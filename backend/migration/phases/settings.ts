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
 * Drains `ctx.source.settings()` itself and buckets every row by its `entity` tag, rather than
 * classifying per tagged row: `mapSiteSettings` builds one patch out of the whole `settings` table,
 * and the other two mappers take their rows up front too, so none of the three has a per-record
 * streaming API to drive. Must therefore run exactly once per phase run — `settingsPhase` below
 * holds the guard that enforces that against `readEntity()`'s per-record `classify` contract.
 *
 * Unlike the users/content phases, classification here touches `CARDINAL` even under `dryRun`: the
 * resolvers are `CARDINAL.models.authentication`/`.storage` themselves, and `getModule()`/
 * `getDefinition()` is what tells a row `created`/`updated` apart from `unsupported` in the first
 * place. Both only read definitions loaded from disk, never `CARDINAL.db`, but it does mean this
 * phase has no pure unit test of its classification — `settings.integration.test.ts` covers it.
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

  // -> One sentinel record for the whole patch: it is a merge of every `settings`-tagged row at
  //    once, so there is no per-row identity to report against and this counts as exactly one
  //    `wouldCreate` however many source rows fed it, including zero. The mapping itself is pure,
  //    so it runs either way; only the writes below are conditional.
  const { siteConfigPatch, instanceSettings } = mapSiteSettings(settingsRows)
  await recorder.create('site-config', async () => {
    if (Object.keys(siteConfigPatch).length > 0) {
      // -> `updateSite()` merges its `config` patch onto the destination row, so it is already safe
      //    against the wholesale-replace hazard `mail`/`security` below have to guard against.
      await CARDINAL.models.sites.updateSite(ctx.siteId, { config: siteConfigPatch })
    }
    if (instanceSettings.mail) {
      // -> `settings.updateConfig(key, value)` REPLACES the whole `mail` row, so writing the mapper's
      //    patch through it would silently delete every field the patch doesn't produce (it carries
      //    no `defaultBaseURL`, for one). Merge onto `CARDINAL.config.mail` — already the DB-loaded
      //    value by the time any phase runs — and save the whole back, exactly as `api/mail.ts`'s
      //    PATCH handler does, rather than hand-rolling a second merge.
      const previousMail = CARDINAL.config.mail
      CARDINAL.config.mail = { ...previousMail, ...instanceSettings.mail }
      if (!(await CARDINAL.configSvc.saveToDb(['mail']))) {
        CARDINAL.config.mail = previousMail
        throw new Error('failed to save mail configuration during migration')
      }
    }
    if (instanceSettings.security) {
      // -> Same wholesale-replace hazard as `mail` above, but `models/security.ts` already exposes
      //    the correct merge-then-save, so call it rather than repeating the merge here.
      const saved = await CARDINAL.models.security.updateConfig(instanceSettings.security)
      if (!saved) {
        throw new Error('failed to save security configuration during migration')
      }
    }
  })

  const authResolver: AuthModuleResolver = CARDINAL.models.authentication
  // -> Every created strategy's `autoEnrollGroups` is silently `[]` whatever the 2.x row held:
  //    remapping needs old-group-id -> new-group-UUID entries that only exist once `users` has run,
  //    and `users` depends on this phase. Nothing in `PhaseReport` is shaped to surface the loss, so
  //    it is neither reported nor fixable without re-ordering the phases or a second pass over the
  //    created strategies.
  const authResult = await mapAuthenticationRows(authRows, { resolver: authResolver })
  for (const result of authResult.results) {
    switch (result.status) {
      case 'created': {
        const row = result.row!
        await recorder.create(result.sourceKey, () =>
          CARDINAL.models.authentication
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
        recorder.unmappable(
          result.sourceKey,
          'unsupported-auth-provider',
          result.message ?? `authentication module '${result.module}' has no 3.0 destination`
        )
        break
      case 'flagged':
        // -> The module exists but its config could not be safely carried across: read, not
        //    written, and not an error, so `skipExisting` rather than `conflict` (which is reserved
        //    for two records genuinely colliding). It records only a count, so `result.message` —
        //    which module, and why — would vanish if it were not logged here.
        ctx.log?.(
          `authentication strategy '${result.sourceKey}' (module '${result.module}') not created: ${result.message}`
        )
        recorder.skipExisting(result.sourceKey)
        break
    }
  }

  const storageResolver: StorageModuleResolver = CARDINAL.models.storage
  const storageResult = await mapStorageRows(storageRows, {
    resolver: storageResolver,
    siteId: ctx.siteId
  })
  for (const result of storageResult.results) {
    switch (result.status) {
      case 'updated': {
        const update = result.update!
        const identifier = `${result.sourceKey}@${ctx.siteId}`
        // -> Read outside `recorder.create()`'s write callback, and ungated by `ctx.dryRun`, because
        //    exactly one recorder method may be called per record: a `conflict()` nested inside a
        //    `create()` that already counted this row would break `found`'s bucket invariant.
        const targets = await CARDINAL.models.storage.getSiteTargets(ctx.siteId)
        const existing = targets.find((t) => t.module === update.module)
        if (!existing) {
          // -> Structurally shouldn't happen: site creation seeds one row per module definition on
          //    disk, and `'updated'` is only reached for a module the resolver recognizes. Reported
          //    rather than thrown so one missing row (a site predating a module, say) doesn't abort
          //    the phase's remaining rows.
          recorder.conflict(
            identifier,
            `no existing storage row for module '${update.module}' on site ${ctx.siteId} — ` +
              'Sites.createSite()/Storage.syncSite() should have seeded one at site-creation time'
          )
          break
        }
        // -> `droppedFields` is set only when a real source value could not be converted to 3.0's
        //    shape. Nothing in the update payload carries it through to the write, so logging it is
        //    what keeps the loss from being silent; the row itself is still created.
        if (result.droppedFields) {
          ctx.log?.(
            `storage target '${result.sourceKey}@${ctx.siteId}': could not convert ${Object.keys(result.droppedFields).join('/')} to 3.0's shape — left at the destination's existing/default value. Dropped: ${JSON.stringify(result.droppedFields)}`
          )
        }
        await recorder.create(identifier, () =>
          CARDINAL.models.storage
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
        // -> Same bucket, and the same reason for logging, as the authentication 'flagged' case.
        ctx.log?.(
          `storage target '${result.sourceKey}@${ctx.siteId}' (module '${result.module}') not updated: ${result.message}`
        )
        recorder.skipExisting(result.sourceKey)
        break
    }
  }
}

/**
 * Runs first and depends on nothing: everything else in a 2.x install is read relative to how the
 * destination is configured to store and render it.
 *
 * The closure-scoped `started` flag is what keeps `runSettingsImport()` to one call per phase run,
 * since `classify` is otherwise invoked per tagged row. `readEntity()`'s own count still reports
 * every raw row found; the recorder calls inside `runSettingsImport()` are what populate the report,
 * and the two deliberately do not line up 1:1.
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
