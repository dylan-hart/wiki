import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CustomError } from '../helpers/common.ts'
import { renderRefusalGuidance } from './renderRefusal.ts'

test('renderRefusalGuidance: renderPuppeteerMissing keeps the original message and adds a next step', () => {
  const err = new CustomError(
    'renderPuppeteerMissing',
    'Rendering a page on the server needs the Puppeteer extension, which is not installed.',
    503
  )
  const guidance = renderRefusalGuidance(err)
  assert.match(guidance ?? '', /Puppeteer extension, which is not installed\./)
  assert.match(guidance ?? '', /administrator/)
  assert.match(guidance ?? '', /web editor/)
})

test('renderRefusalGuidance: renderUnsupportedEditor keeps the original message and points at markdown', () => {
  const err = new CustomError(
    'renderUnsupportedEditor',
    'Server-side rendering is not implemented for the ckeditor editor.'
  )
  const guidance = renderRefusalGuidance(err)
  assert.match(guidance ?? '', /ckeditor editor\./)
  assert.match(guidance ?? '', /markdown/)
})

test('renderRefusalGuidance: any other CustomError is left to the caller', () => {
  const err = new CustomError('somethingElse', 'Not a render refusal.')
  assert.equal(renderRefusalGuidance(err), null)
})

test('renderRefusalGuidance: a plain Error is left to the caller', () => {
  assert.equal(renderRefusalGuidance(new Error('boom')), null)
})
