/**
 * For a federated provider that reports only a single display string. The split is deliberately
 * naive and library-free: name-parsing libraries are anglocentric and mis-split many non-Western
 * names, and a confidently wrong split is worse than an obvious guess somebody can correct.
 *
 * Never runs for a name a person typed: local registration and the admin user forms take both
 * halves outright.
 */

/** `''` means "not known", never a fabricated value. */
export interface SplitName {
  firstName: string
  lastName: string
}

export function splitDisplayName(display?: string | null): SplitName {
  const parts = (display ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    return { firstName: '', lastName: '' }
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/**
 * Splits **only** when neither half is already known, so a provider's real name claims — including
 * a deliberate mononym (a `firstName` with an empty `lastName`) — are never re-guessed.
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
