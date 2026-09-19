/**
 * The closed scope vocabulary every log line is filed under. One name per subsystem — a
 * sub-subsystem is a *field* on the line (`scope('storage', { module: 'git' })`), never a new
 * scope. `as const` is what makes anything outside this array a type error at the call site.
 *
 * In its own module rather than in `core/logger.ts` so that a file needing only the *name* of a
 * scope does not pull in the logger implementation; `core/logger.ts` re-exports both names.
 *
 * `docs/operations.md`'s Scopes table says what each name owns; `test/operations-doc.test.ts` fails
 * when the two differ.
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
