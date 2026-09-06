/**
 * Splitting one display string into a first and last name.
 *
 * A federated provider that hands over a single display string (`github`, `discord`, `slack`,
 * `twitch`, `cas`) has to be turned into the two fields this instance stores. That split is
 * deliberately naive — first whitespace-separated part, whole remainder — and no name-parsing
 * library backs it: `humanparser` and `parse-full-name` were both considered and rejected for
 * Feature #2608 because every such library is anglocentric and mis-splits many non-Western names,
 * and a confidently wrong split is worse than an obviously naive one somebody can correct. A wrong
 * guess here reads as a guess, which is the point.
 *
 * This never runs for a name a person actually typed: local registration and the admin user forms
 * take both halves outright, so nothing authored on this instance is routed through it.
 */

/** The two halves, both always strings — `''` means "not known", never a fabricated value. */
export interface SplitName {
  firstName: string
  lastName: string
}

/**
 * Split a provider's single display string into `{ firstName, lastName }`.
 *
 * The first whitespace-separated part becomes `firstName` and the entire remainder — internal
 * spacing collapsed, so `'Ada  B  Lovelace'` keeps `'B Lovelace'` rather than the raw run — becomes
 * `lastName`. A mononym yields an empty `lastName`; an absent, empty or whitespace-only input yields
 * two empty strings. Nothing is ever invented: a person with one name keeps one name.
 */
export function splitDisplayName(display?: string | null): SplitName {
  const parts = (display ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return { firstName: '', lastName: '' }
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/**
 * The halves a provider module should report when its only source is one display string.
 *
 * The split is applied **only** when neither half is already known — a module that read real
 * `given_name`/`family_name` style claims keeps what the provider actually said, including a
 * deliberate mononym (a populated `firstName` with an empty `lastName`), rather than having it
 * re-guessed out of the display string.
 */
export function fillNameHalves(
  display: string | undefined | null,
  known: { firstName?: string; lastName?: string } = {}
): SplitName {
  const firstName = known.firstName ?? ''
  const lastName = known.lastName ?? ''
  if (firstName || lastName) {
    return { firstName, lastName }
  }
  return splitDisplayName(display)
}
