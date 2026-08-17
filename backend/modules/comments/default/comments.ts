/**
 * Wiki.js Native comment provider.
 *
 * This is a scaffold (Task 615, Feature 390): only the module shape and its handler signatures are
 * in place, each stubbed to throw. Feature 389 (the comments data model) owns `models/comments.ts`
 * and, once it lands, the `CommentProviderModule` interface below should move there and this file
 * should import it — the same way `models/storage.ts` and `models/authentication.ts` already own the
 * contracts for their own module kinds.
 *
 * Pure module: no database access, no Fastify route, no Drizzle import. `models/comments.ts` is
 * expected to dynamically import this file's default export the same way `models/storage.ts` loads
 * `modules/storage/<key>/storage.ts`.
 */

/**
 * The contract every comment provider module implements, keyed by the module's own `definition.yml`
 * `props` (see `helpers/common.ts`'s `ModuleProp` for what a resolved prop looks like). Local copy
 * only, for now — see the file-level comment above.
 */
export interface CommentProviderModule {
  /**
   * Render raw comment content (as the author submitted it) to sanitized HTML for display.
   */
  render(content: string): Promise<string>

  /**
   * Whether a comment looks like spam, given the module's own configuration (e.g. an Akismet API
   * key set via the `akismet` prop).
   */
  checkSpam(
    params: { content: string; author: string; email?: string; ip?: string; userAgent?: string },
    conf: Record<string, any>
  ): Promise<boolean>

  /**
   * Whether the poster is within the module's configured minimum delay between comments (the
   * `minDelay` prop). All guests are treated as a single account.
   */
  checkRateLimit(params: { userId: number }, conf: Record<string, any>): Promise<boolean>
}

const commentsDefaultModule: CommentProviderModule = {
  async render(_content) {
    throw new Error('Not implemented')
  },
  async checkSpam(_params, _conf) {
    throw new Error('Not implemented')
  },
  async checkRateLimit(_params, _conf) {
    throw new Error('Not implemented')
  }
}

export default commentsDefaultModule
