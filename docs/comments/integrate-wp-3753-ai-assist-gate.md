# Comment recommendations: integrating WP #3753 (`wp-3753-ai-assist-gate`)

## backend/helpers/aiAssist.ts: `aiRegistry`

- **Do not Add** the `TODO` that `docs/comments/wp-3753.md` proposes above `export function
aiRegistry()` ("read `CARDINAL.models.ai` directly once `models/ai.ts` is on this branch's
  base…").
- **Reason:** obsolete on the integration branch. `models/ai.ts` is present here, and the
  integration merge already replaced the `as unknown as` structural cast with a direct read typed as
  `Pick<typeof ai, 'generate'>` from `models/ai.ts`, so the defect the TODO describes no longer
  exists.
