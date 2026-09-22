import { afterEach, describe, expect, it, vi } from 'vitest'

import { findUnresolvedImageReferences, resolvePendingImages } from './pendingImages'

function image(n, src, alt = 'pic') {
  return { token: `pending-image:${n}`, src, alt }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolvePendingImages', () => {
  it('replaces each placeholder with the blob URL of its fetched bytes', async () => {
    const blob = new Blob(['x'])
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) })
    )
    const addPendingAsset = vi.fn().mockReturnValue('blob:one')

    const result = await resolvePendingImages(
      'a ![pic](pending-image:0) b',
      [image(0, 'data:image/png;base64,AAAA')],
      { addPendingAsset }
    )

    expect(result).toBe('a ![pic](blob:one) b')
    expect(addPendingAsset).toHaveBeenCalledWith(blob)
  })

  it('drops only the image whose src cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('cors'))
        .mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['x'])) })
    )
    const addPendingAsset = vi.fn().mockReturnValue('blob:two')

    const result = await resolvePendingImages(
      '![pic](pending-image:0)|![pic](pending-image:1)',
      [image(0, 'https://elsewhere.test/a.png'), image(1, 'https://elsewhere.test/b.png')],
      { addPendingAsset }
    )

    expect(result).toBe('|![pic](blob:two)')
  })

  it('drops every placeholder without fetching when refuse is set', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const addPendingAsset = vi.fn()

    const result = await resolvePendingImages('x ![pic](pending-image:0) y', [image(0, 'blob:z')], {
      refuse: true,
      addPendingAsset
    })

    expect(result).toBe('x  y')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(addPendingAsset).not.toHaveBeenCalled()
  })

  it('keeps the original reference, without fetching or uploading, when keepReferences is set', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const addPendingAsset = vi.fn()

    const result = await resolvePendingImages(
      '![a](pending-image:0)\n![b](pending-image:1)',
      [image(0, 'media/image1.png', 'a'), image(1, 'https://elsewhere.test/b.png', 'b')],
      { keepReferences: true, addPendingAsset }
    )

    expect(result).toBe('![a](media/image1.png)\n![b](https://elsewhere.test/b.png)')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(addPendingAsset).not.toHaveBeenCalled()
  })
})

describe('findUnresolvedImageReferences', () => {
  it('returns nothing for markdown without images', () => {
    expect(findUnresolvedImageReferences('# Title\n\nJust text.')).toEqual([])
  })

  it('flags relative, file:, blob: and pending-image: references', () => {
    const md = [
      '![a](media/image1.png)',
      '![b](./notes_files/image002.jpg)',
      '![c](../up.png)',
      '![d](file:///C:/x.png)',
      '![e](blob:https://x.test/1)',
      '![f](pending-image:3)'
    ].join('\n')

    expect(findUnresolvedImageReferences(md)).toEqual([
      'media/image1.png',
      './notes_files/image002.jpg',
      '../up.png',
      'file:///C:/x.png',
      'blob:https://x.test/1',
      'pending-image:3'
    ])
  })

  it('leaves http(s), data: and root-absolute references alone', () => {
    const md = [
      '![a](https://x.test/a.png)',
      '![b](http://x.test/b.png)',
      '![c](data:image/png;base64,AAAA)',
      '![d](/_assets/d.png)',
      '![e](//cdn.test/e.png)'
    ].join('\n')

    expect(findUnresolvedImageReferences(md)).toEqual([])
  })

  it('reads a title and an angle-bracketed destination', () => {
    const md = '![a](media/one.png "A title")\n![b](<my files/two.png>)'

    expect(findUnresolvedImageReferences(md)).toEqual(['media/one.png', 'my files/two.png'])
  })

  it('finds inline HTML <img> tags', () => {
    const md = 'text <img src="media/three.png" width="10"> and <img alt=x src=\'four.png\'>'

    expect(findUnresolvedImageReferences(md)).toEqual(['media/three.png', 'four.png'])
  })

  it('ignores image syntax inside fenced code and inline code', () => {
    const md = '```\n![a](media/in-fence.png)\n```\n\nUse `![b](media/in-span.png)` here.'

    expect(findUnresolvedImageReferences(md)).toEqual([])
  })
})
