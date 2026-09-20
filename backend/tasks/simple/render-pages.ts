/**
 * The queue is drained by one job rather than split across several: rendering means driving a
 * headless browser, and there is one browser, rendering one page at a time. A run that finds the
 * queue empty — a second job for a batch this one already swept — launches nothing.
 */
export async function task(): Promise<void> {
  await CARDINAL.models.renderQueue.drainQueue()
}
