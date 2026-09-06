/**
 * The closed scope vocabulary every log line is filed under.
 *
 * One name per subsystem, and a line names exactly one of them — a sub-subsystem is a *field* on the
 * line (`scope('storage', { module: 'git' })`), never a new scope. Adding a genuinely new subsystem
 * is a one-line edit here; anything outside this array is a type error at the call site, which is
 * the whole point of the array being `as const`.
 *
 * Kept in its own module rather than in `core/logger.ts` so that a file needing only the *name* of a
 * scope (a type import) does not pull in the logger implementation, and so that extending the
 * vocabulary never touches the renderer. `core/logger.ts` re-exports both names, so
 * `import { LOG_SCOPES } from './logger.ts'` reads the same values.
 *
 * `docs/logging-reviews/2026-09-05-recommendations.md` §2.3 is the table this mirrors, in its order,
 * and says what each name owns.
 */
export const LOG_SCOPES = [
  'boot',
  'config',
  'db',
  'sql',
  'http',
  'auth',
  'session',
  'jobs',
  'worker',
  'mail',
  'storage',
  'search',
  'render',
  'collab',
  'cluster',
  'locale',
  'icons',
  'blocks',
  'ext',
  'pages',
  'assets',
  'nav',
  'hooks',
  'mcp',
  'terminal',
  'migrate',
  'audit'
] as const

export type LogScope = (typeof LOG_SCOPES)[number]
