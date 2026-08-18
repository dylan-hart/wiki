import { definePhase } from './define-phase.ts'

/**
 * Phase 1 (Feature 420: settings/auth/storage config importer). No dependency — everything else in a
 * 2.x install is read relative to how the destination is configured to store and render it.
 */
export const settingsPhase = definePhase({
  id: 'settings',
  label: 'Settings, authentication & storage config',
  dependsOn: [],
  entities: (ctx) => ({
    settings: () => ctx.source.settings()
  })
})
