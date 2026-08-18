import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import { usersPhase } from './users.ts'
import type { MigrationPhase, MigrationPhaseId } from '../context.ts'

/**
 * Every migration phase, in the dependency order Feature 421 task 742 specifies: settings/auth/
 * storage config (420) before users/groups (414), before content (416), before assets/comments-
 * staging (418). `runMigration` (`../orchestrator.ts`) walks this array in order; `--only` filters it
 * down to a subset without changing the order those it keeps run in.
 */
export const MIGRATION_PHASES: MigrationPhase[] = [
  settingsPhase,
  usersPhase,
  contentPhase,
  assetsPhase
]

export const MIGRATION_PHASE_IDS: MigrationPhaseId[] = MIGRATION_PHASES.map((phase) => phase.id)
