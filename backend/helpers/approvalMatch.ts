/**
 * How an approval rule decides which pages it covers. The same set group page rules use, so an
 * administrator writing one has learnt the other.
 *
 * Lives here, rather than in `models/approvals.ts` where it originated, so `db/schema.ts` can type
 * `approvalRules.match` against {@link ApprovalMatchMode} without importing a model into the schema
 * module. `models/approvals.ts` re-exports both names, so nothing importing them from there needs to
 * change.
 */
export const approvalMatchModes = ['START', 'EXACT', 'END', 'REGEX', 'TAG', 'TAGALL'] as const

export type ApprovalMatchMode = (typeof approvalMatchModes)[number]
