import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { usePathDisplay } from './pathDisplay.js'
import { useSiteStore } from '@/stores/site'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('usePathDisplay(): isActive', () => {
  it('is false when the site setting is off (the default)', () => {
    const { isActive } = usePathDisplay()
    expect(isActive.value).toBe(false)
  })

  it('is true for every non-off case style', () => {
    const siteStore = useSiteStore()
    for (const caseStyle of ['lower', 'upper', 'camel', 'pascal', 'title']) {
      siteStore.pathDisplayCase = caseStyle
      const { isActive } = usePathDisplay()
      expect(isActive.value).toBe(true)
    }
  })
})

describe('usePathDisplay(): humanize()', () => {
  it('returns the segment unchanged when the setting is off', () => {
    const { humanize } = usePathDisplay()
    expect(humanize('getting-started')).toBe('getting-started')
  })

  it('translates the site enum (camel/pascal/title) into the helper’s own case-style vocabulary', () => {
    const siteStore = useSiteStore()

    siteStore.pathDisplayCase = 'lower'
    expect(usePathDisplay().humanize('getting-started')).toBe('getting-started')

    siteStore.pathDisplayCase = 'upper'
    expect(usePathDisplay().humanize('getting-started')).toBe('GETTING-STARTED')

    siteStore.pathDisplayCase = 'camel'
    expect(usePathDisplay().humanize('getting-started')).toBe('gettingStarted')

    siteStore.pathDisplayCase = 'pascal'
    expect(usePathDisplay().humanize('getting-started')).toBe('GettingStarted')

    siteStore.pathDisplayCase = 'title'
    expect(usePathDisplay().humanize('getting-started')).toBe('Getting Started')
  })

  it('consults the site acronym map for a casing override, in any style', () => {
    const siteStore = useSiteStore()
    siteStore.pathDisplayCase = 'title'
    siteStore.acronymMap = { uss: 'USS' }

    expect(usePathDisplay().humanize('uss-enterprise')).toBe('USS Enterprise')
  })

  it('re-reads the store on every call, rather than snapshotting at setup time', () => {
    const siteStore = useSiteStore()
    const { humanize } = usePathDisplay()

    expect(humanize('getting-started')).toBe('getting-started')

    siteStore.pathDisplayCase = 'upper'
    expect(humanize('getting-started')).toBe('GETTING-STARTED')

    siteStore.acronymMap = { getting: 'GETTING!' }
    expect(humanize('getting-started')).toBe('GETTING!-STARTED')
  })
})
