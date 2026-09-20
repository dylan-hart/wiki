import { describe, expect, it } from 'vitest'

import { DUPLICATED_PAGE_PROPS, duplicatedPageProps } from './duplicatedPageProps.js'

describe('duplicatedPageProps', () => {
  it('copies every listed property off the source', () => {
    const source = {
      description: 'd',
      icon: 'mdi:home',
      tags: ['a'],
      relations: [{ id: 'r1', target: 'x' }],
      classification: 'level-2',
      publishState: 'draft',
      isBrowsable: false,
      isSearchable: false,
      allowComments: false,
      allowContributions: false,
      showSidebar: false,
      showTags: false,
      showToc: false,
      tocDepth: { min: 2, max: 4 }
    }
    expect(duplicatedPageProps(source)).toEqual(source)
  })

  it('never carries the password, alias, per-page scripts or identity', () => {
    const props = duplicatedPageProps({
      password: 'hunter2',
      hasPassword: true,
      alias: 'taken',
      scriptCss: 'a{}',
      scriptJsLoad: 'x()',
      scriptJsUnload: 'y()',
      id: 'page-1',
      path: 'p',
      title: 't',
      createdAt: 'then',
      authorId: 3
    })
    expect(props).toEqual({})
    for (const key of ['password', 'alias', 'scriptCss', 'scriptJsLoad', 'scriptJsUnload']) {
      expect(DUPLICATED_PAGE_PROPS).not.toContain(key)
    }
  })

  it('carries the schedule only alongside a scheduled state', () => {
    const dates = {
      publishStartDate: '2026-10-01T00:00:00Z',
      publishEndDate: '2026-11-01T00:00:00Z'
    }

    expect(duplicatedPageProps({ publishState: 'scheduled', ...dates })).toEqual({
      publishState: 'scheduled',
      ...dates
    })
    expect(duplicatedPageProps({ publishState: 'draft', ...dates })).toEqual({
      publishState: 'draft'
    })
    expect(duplicatedPageProps({ publishState: 'published', ...dates })).toEqual({
      publishState: 'published'
    })
    expect(duplicatedPageProps(dates)).toEqual({})
  })

  it('skips null and undefined values and tolerates a missing source', () => {
    expect(duplicatedPageProps({ icon: null, classification: null, tags: undefined })).toEqual({})
    expect(duplicatedPageProps(undefined)).toEqual({})
  })
})
