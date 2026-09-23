import { describe, expect, it } from 'vitest'

import { MAX_BLOCK_BYTES, MAX_PAGE_BYTES, MAX_POINTS, MAX_STROKES } from './limits.js'

describe('block-whiteboard size cap', () => {
  it('holds the pinned literal numbers the backend and frontend copies share', () => {
    expect(MAX_BLOCK_BYTES).toBe(262144)
    expect(MAX_STROKES).toBe(2000)
    expect(MAX_POINTS).toBe(50000)
    expect(MAX_PAGE_BYTES).toBe(1048576)
  })
})
