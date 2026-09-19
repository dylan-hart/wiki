import { assetsPhase } from './assets.ts'
import { contentPhase } from './content.ts'
import { settingsPhase } from './settings.ts'
import { usersPhase } from './users.ts'
import type { MigrationPhase, MigrationPhaseId } from '../context.ts'

/**
 * Array order is the run order: `runMigration` walks it as-is and `--only` filters it to a subset
 * without reordering what it keeps.
 */
export const MIGRATION_PHASES: MigrationPhase[] = [
  settingsPhase,
  usersPhase,
  contentPhase,
  assetsPhase
]

export const MIGRATION_PHASE_IDS: MigrationPhaseId[] = MIGRATION_PHASES.map((phase) => phase.id)
