import type { TaskResult } from '../../core/scheduler.ts'

/**
 * A note image is otherwise deleted only with its note, so one taken out of the note's content, or
 * uploaded to a note the editor had already left, would stay in postgres for good.
 */
export async function task(): Promise<TaskResult | void> {
  const purged = await CARDINAL.models.notes.purgeOrphanImages()
  if (purged > 0) {
    return { summary: 'purged note images no note shows any more', purged }
  }
}
