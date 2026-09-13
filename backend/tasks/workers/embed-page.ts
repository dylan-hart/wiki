/**
 * Cross-task coordination stub — Epic #3050 (semantic/vector search), Round 2 plan.
 *
 * The real delete-existing-chunks / re-render / re-chunk / re-embed / insert pipeline for one page
 * belongs to Task #3098 and is not merged yet (verified: no `helpers/embeddings.ts` or real version of
 * this file exists in this worktree). The epic's own coordination note calls this a "contract-only
 * (stub, don't block)" dependency: `embedPage(pageId)` is documented as "a plain importable function
 * ... callable both from the worker-thread task entry and from a loop in #3104's rebuild action", so
 * Task #3104 (this file's only reason for existing right now) needs a real, importable symbol at this
 * exact path to build and test its rebuild action against today, rather than waiting on a merge.
 *
 * This stub is deliberately a no-op. #3098's real implementation supersedes this file wholesale — it
 * is expected to conflict with (and win over) this version at integration time, not merge line-by-line
 * with it.
 */
export async function embedPage(_pageId: string): Promise<void> {
  // -> No-op until Task #3098 lands the real chunk/embed/insert pipeline.
}

/**
 * The worker-thread entry point `backend/worker.ts` dynamically imports
 * (`tasks/workers/${kebabCase(job.task)}.ts`) and calls as `task(job)` — see `tasks/workers/
 * dispatch-webhook.ts` for the established shape. Included here so a job queued with
 * `task: 'embedPage'` before #3098 lands does not throw on a missing export; #3098's real file will
 * replace this alongside `embedPage` itself.
 */
export async function task(job: { payload?: { pageId?: string } }): Promise<void> {
  if (job.payload?.pageId) {
    await embedPage(job.payload.pageId)
  }
}
