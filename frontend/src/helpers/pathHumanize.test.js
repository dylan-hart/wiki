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
})
