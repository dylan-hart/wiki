/**
 * Lives here, not in `models/approvalRules.ts` (which re-exports both names), so `db/schema.ts` can
 * type `approvalRules.match` against {@link ApprovalMatchMode} without importing a model into the
 * schema module.
 */
export const approvalMatchModes = ['START', 'EXACT', 'END', 'REGEX', 'TAG', 'TAGALL'] as const

export type ApprovalMatchMode = (typeof approvalMatchModes)[number]
