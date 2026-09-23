import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  assetTargets,
  findNoteImageRefs,
  noteImageUrl,
  parentFolderOf,
  rewriteNoteImageRefs
} from './notePromotion.ts'

const SITE = '11111111-1111-4111-8111-111111111111'
const OTHER_SITE = '22222222-2222-4222-8222-222222222222'
const NOTE = '33333333-3333-4333-8333-333333333333'
const OTHER_NOTE = '44444444-4444-4444-8444-444444444444'
const IMAGE_A = '55555555-5555-4555-8555-555555555555'
const IMAGE_B = '66666666-6666-4666-8666-666666666666'

describe('findNoteImageRefs', () => {
  test('finds each image of this site once, whichever note it belongs to', () => {
    const a = noteImageUrl(SITE, NOTE, IMAGE_A)
    const b = noteImageUrl(SITE, OTHER_NOTE, IMAGE_B)
    const content = `![one](${a})\n\n![again](${a} "title")\n\n<img src="${b}">`
    assert.deepEqual(findNoteImageRefs(content, SITE), [
      { noteId: NOTE, imageId: IMAGE_A },
      { noteId: OTHER_NOTE, imageId: IMAGE_B }
    ])
  })

  test("ignores another site's note images and anything that only looks like one", () => {
    const content = [
      `![x](${noteImageUrl(OTHER_SITE, NOTE, IMAGE_A)})`,
      `![y](/_api/sites/${SITE}/notes/${NOTE}/images/not-a-uuid)`,
      `![z](${noteImageUrl(SITE, NOTE, IMAGE_A)}/thumbnail)`,
      `![w](/_files/docs/photo.png)`
    ].join('\n')
    assert.deepEqual(findNoteImageRefs(content, SITE), [])
  })

  test('matches an absolute URL to the same route', () => {
    const content = `![x](https://wiki.example.com${noteImageUrl(SITE, NOTE, IMAGE_A)})`
    assert.deepEqual(findNoteImageRefs(content, SITE), [{ noteId: NOTE, imageId: IMAGE_A }])
  })

  test('folds upper-case ids to the form postgres returns', () => {
    const content = `![x](${noteImageUrl(SITE, NOTE.toUpperCase(), IMAGE_A.toUpperCase())})`
    assert.deepEqual(findNoteImageRefs(content, SITE), [{ noteId: NOTE, imageId: IMAGE_A }])
  })
})

describe('rewriteNoteImageRefs', () => {
  test('replaces every occurrence it has a target for and leaves the rest', () => {
    const a = noteImageUrl(SITE, NOTE, IMAGE_A)
    const b = noteImageUrl(SITE, NOTE, IMAGE_B)
    const content = `![one](${a}) ![two](${b}) ![three](https://host.example${a})`
    const rewritten = rewriteNoteImageRefs(content, SITE, (ref) =>
      ref.imageId === IMAGE_A ? '/docs/photo.png' : undefined
    )
    assert.equal(rewritten, `![one](/docs/photo.png) ![two](${b}) ![three](/docs/photo.png)`)
  })

  test("never touches another site's URL", () => {
    const foreign = noteImageUrl(OTHER_SITE, NOTE, IMAGE_A)
    assert.equal(
      rewriteNoteImageRefs(`![x](${foreign})`, SITE, () => '/nope.png'),
      `![x](${foreign})`
    )
  })
})

describe('assetTargets', () => {
  test('a page source path for the content and a served path for the render', () => {
    assert.deepEqual(assetTargets('docs/guides', 'photo-1.png'), {
      content: '/docs/guides/photo-1.png',
      render: '/_files/docs/guides/photo-1.png'
    })
  })

  test('at the site root', () => {
    assert.deepEqual(assetTargets('', 'photo.png'), {
      content: '/photo.png',
      render: '/_files/photo.png'
    })
  })
})

describe('parentFolderOf', () => {
  test('the folder the page editor uploads into, normalized as a page path', () => {
    assert.equal(parentFolderOf('/Docs/Guides/My Idea/'), 'docs/guides')
    assert.equal(parentFolderOf('idea'), '')
  })
})
