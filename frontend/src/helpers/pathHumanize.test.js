import { describe, expect, it } from 'vitest'

import { humanizePathSegment, PATH_CASE_STYLES } from './pathHumanize.js'

describe('PATH_CASE_STYLES', () => {
  it('lists the 5 case styles the parent Feature describes', () => {
    expect(PATH_CASE_STYLES).toEqual(['lower', 'upper', 'camelCase', 'pascalCase', 'titleCase'])
  })
})

describe('humanizePathSegment', () => {
  it('returns falsy input unchanged', () => {
    expect(humanizePathSegment('', 'lower')).toBe('')
    expect(humanizePathSegment(null, 'lower')).toBe(null)
    expect(humanizePathSegment(undefined, 'titleCase')).toBe(undefined)
  })

  it('falls back to lower for an unrecognized case style', () => {
    expect(humanizePathSegment('getting-started', 'bogus')).toBe('getting-started')
  })

  describe('with no acronym map', () => {
    it('lower keeps hyphens and lowercases each word', () => {
      expect(humanizePathSegment('getting-started', 'lower')).toBe('getting-started')
    })

    it('upper keeps hyphens and uppercases each word', () => {
      expect(humanizePathSegment('getting-started', 'upper')).toBe('GETTING-STARTED')
    })

    it('camelCase joins words with no delimiter, first word lowercase', () => {
      expect(humanizePathSegment('getting-started', 'camelCase')).toBe('gettingStarted')
    })

    it('pascalCase joins words with no delimiter, every word capitalized', () => {
      expect(humanizePathSegment('getting-started', 'pascalCase')).toBe('GettingStarted')
    })

    it('titleCase space-joins and capitalizes each word', () => {
      expect(humanizePathSegment('getting-started', 'titleCase')).toBe('Getting Started')
    })

    it('titleCase lowercases a minor word in the middle but not at the edges', () => {
      expect(humanizePathSegment('state-of-the-art', 'titleCase')).toBe('State of the Art')
      expect(humanizePathSegment('of-all-things', 'titleCase')).toBe('Of All Things')
    })

    it('a single-word segment is unaffected by hyphen handling', () => {
      expect(humanizePathSegment('runners', 'titleCase')).toBe('Runners')
    })
  })

  describe('with an acronym map (Map)', () => {
    const acronyms = new Map([
      ['uss', 'USS'],
      ['irv', 'IRV']
    ])

    it('overrides a matched word verbatim regardless of case style, first position', () => {
      expect(humanizePathSegment('uss-runners', 'lower', acronyms)).toBe('USS-runners')
      expect(humanizePathSegment('uss-runners', 'upper', acronyms)).toBe('USS-RUNNERS')
      expect(humanizePathSegment('uss-runners', 'camelCase', acronyms)).toBe('USSRunners')
      expect(humanizePathSegment('uss-runners', 'pascalCase', acronyms)).toBe('USSRunners')
      expect(humanizePathSegment('uss-runners', 'titleCase', acronyms)).toBe('USS Runners')
    })

    it('overrides a matched word verbatim in the middle position', () => {
      expect(humanizePathSegment('the-uss-runners', 'titleCase', acronyms)).toBe('The USS Runners')
    })

    it('overrides a matched word verbatim in the last position', () => {
      expect(humanizePathSegment('runners-uss', 'titleCase', acronyms)).toBe('Runners USS')
      expect(humanizePathSegment('runners-uss', 'pascalCase', acronyms)).toBe('RunnersUSS')
    })

    it('overrides more than one acronym in the same segment', () => {
      expect(humanizePathSegment('uss-irv-runners', 'titleCase', acronyms)).toBe('USS IRV Runners')
    })

    it('an acronym match beats titleCase minor-word lowercasing', () => {
      const minorWordAcronym = new Map([['of', 'OF']])
      expect(humanizePathSegment('state-of-the-art', 'titleCase', minorWordAcronym)).toBe(
        'State OF the Art'
      )
    })

    it('leaves a non-matching word to the style as usual', () => {
      expect(humanizePathSegment('irv-nowhere', 'lower', acronyms)).toBe('IRV-nowhere')
    })
  })

  describe('with an acronym map (plain object)', () => {
    it('is accepted the same way a Map is', () => {
      expect(humanizePathSegment('uss-runners', 'pascalCase', { uss: 'USS' })).toBe('USSRunners')
    })
  })

  describe('with no acronyms configured', () => {
    it('treats null the same as an empty map', () => {
      expect(humanizePathSegment('getting-started', 'titleCase', null)).toBe('Getting Started')
    })

    it('treats undefined the same as an empty map', () => {
      expect(humanizePathSegment('getting-started', 'titleCase', undefined)).toBe('Getting Started')
    })
  })

  const acronyms = new Map([
    ['uss', 'USS'],
    ['irv', 'IRV']
  ])

  const CASES = [
    // [segment, caseStyle, acronymMap, expected]
    ['getting-started', 'lower', undefined, 'getting-started'],
    ['getting-started', 'upper', undefined, 'GETTING-STARTED'],
    ['getting-started', 'camelCase', undefined, 'gettingStarted'],
    ['getting-started', 'pascalCase', undefined, 'GettingStarted'],
    ['getting-started', 'titleCase', undefined, 'Getting Started'],

    ['runners', 'lower', undefined, 'runners'],
    ['runners', 'upper', undefined, 'RUNNERS'],
    ['runners', 'camelCase', undefined, 'runners'],
    ['runners', 'pascalCase', undefined, 'Runners'],
    ['runners', 'titleCase', undefined, 'Runners'],

    ['state-of-the-art', 'titleCase', undefined, 'State of the Art'],
    ['of-all-things', 'titleCase', undefined, 'Of All Things'],
    ['state-of-the-art', 'camelCase', undefined, 'stateOfTheArt'],
    ['state-of-the-art', 'pascalCase', undefined, 'StateOfTheArt'],

    // a digit-leading word after the first position is prefixed with `_`, not capitalized
    ['v2-release', 'lower', undefined, 'v2-release'],
    ['v2-release', 'upper', undefined, 'V2-RELEASE'],
    ['v2-release', 'camelCase', undefined, 'v2Release'],
    ['v2-release', 'pascalCase', undefined, 'V2Release'],
    ['v2-release', 'titleCase', undefined, 'V2 Release'],
    ['release-2-notes', 'camelCase', undefined, 'release_2Notes'],
    ['release-2-notes', 'pascalCase', undefined, 'Release_2Notes'],
    ['2-factor-auth', 'camelCase', undefined, '2FactorAuth'],
    ['2-factor-auth', 'pascalCase', undefined, '2FactorAuth'],

    ['-getting-started', 'titleCase', undefined, 'Getting Started'],
    ['getting-started-', 'titleCase', undefined, 'Getting Started'],
    ['-getting-started-', 'camelCase', undefined, 'gettingStarted'],

    ['uss-runners', 'lower', acronyms, 'USS-runners'],
    ['uss-runners', 'upper', acronyms, 'USS-RUNNERS'],
    ['uss-runners', 'camelCase', acronyms, 'USSRunners'],
    ['uss-runners', 'pascalCase', acronyms, 'USSRunners'],
    ['uss-runners', 'titleCase', acronyms, 'USS Runners'],
    ['the-uss-runners', 'titleCase', acronyms, 'The USS Runners'],
    ['runners-uss', 'titleCase', acronyms, 'Runners USS'],
    ['runners-uss', 'pascalCase', acronyms, 'RunnersUSS'],
    ['uss-irv-runners', 'titleCase', acronyms, 'USS IRV Runners']
  ]

  describe.each(CASES)('%s / %s', (segment, caseStyle, acronymMap, expected) => {
    it(`→ ${expected}`, () => {
      expect(humanizePathSegment(segment, caseStyle, acronymMap)).toBe(expected)
    })
  })
})
