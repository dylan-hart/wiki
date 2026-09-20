import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { mapGoogleProfile } from './authentication.ts'

/**
 * Only the claim mapping is asserted: everything around it — discovery, the code exchange, ID-token
 * verification — is `openid-client`'s own tested job, and faking an issuer here would re-describe it
 * rather than verify anything.
 */
describe('mapGoogleProfile', () => {
  const claims = {
    sub: 'google-oauth2|1234',
    email: 'alice@example.com',
    email_verified: true,
    name: 'Alice Example',
    given_name: 'Alice',
    family_name: 'Example'
  }

  test('maps subject, email and the display-name claim', () => {
    const profile = mapGoogleProfile({}, claims)
    assert.equal(profile.id, 'google-oauth2|1234')
    assert.equal(profile.email, 'alice@example.com')
    assert.equal(profile.name, 'Alice Example')
  })

  test('falls back to the email address when Google reports no display name', () => {
    const profile = mapGoogleProfile({}, { ...claims, name: undefined })
    assert.equal(profile.name, 'alice@example.com')
  })

  test('throws ERR_NO_EMAIL_FROM_PROVIDER when the email claim is absent', () => {
    assert.throws(
      () => mapGoogleProfile({}, { ...claims, email: undefined }),
      /ERR_NO_EMAIL_FROM_PROVIDER/
    )
  })

  test('throws ERR_EMAIL_NOT_VERIFIED when email_verified is explicitly false', () => {
    assert.throws(
      () => mapGoogleProfile({}, { ...claims, email_verified: false }),
      /ERR_EMAIL_NOT_VERIFIED/
    )
  })

  test('allowUnverifiedEmail re-permits an explicitly-false email_verified claim', () => {
    const profile = mapGoogleProfile(
      { allowUnverifiedEmail: true },
      { ...claims, email_verified: false }
    )
    assert.equal(profile.email, 'alice@example.com')
  })

  test('a configured hostedDomain refuses an account from a different Workspace domain', () => {
    assert.throws(
      () => mapGoogleProfile({ hostedDomain: 'example.com' }, { ...claims, hd: 'other.example' }),
      /ERR_LOGIN_RESTRICTED/
    )
  })

  test('a configured hostedDomain accepts an account whose hd claim matches', () => {
    const profile = mapGoogleProfile(
      { hostedDomain: 'example.com' },
      { ...claims, hd: 'example.com' }
    )
    assert.equal(profile.email, 'alice@example.com')
  })

  test('reads the fixed given_name/family_name claims into the separated halves', () => {
    const profile = mapGoogleProfile({}, claims)
    assert.equal(profile.firstName, 'Alice')
    assert.equal(profile.lastName, 'Example')
    assert.equal(profile.name, 'Alice Example')
  })

  test('an account with only a given name keeps it and gets no invented surname', () => {
    const profile = mapGoogleProfile({}, { ...claims, name: 'Prince', family_name: undefined })
    assert.equal(profile.firstName, 'Alice')
    assert.equal('lastName' in profile, false)
  })

  test('an account Google reports no separated name for leaves both keys off the profile', () => {
    const profile = mapGoogleProfile(
      {},
      { ...claims, given_name: undefined, family_name: undefined }
    )
    assert.equal('firstName' in profile, false)
    assert.equal('lastName' in profile, false)
  })

  test('the halves are read from claims, not split off the display name', () => {
    const profile = mapGoogleProfile(
      {},
      { ...claims, name: 'Dr. Alice Example', given_name: undefined, family_name: undefined }
    )
    assert.equal('firstName' in profile, false)
    assert.equal(profile.name, 'Dr. Alice Example')
  })

  test('reads the picture claim into the profile', () => {
    const profile = mapGoogleProfile(
      {},
      { ...claims, picture: 'https://lh3.googleusercontent.com/a/abc123' }
    )
    assert.equal(profile.picture, 'https://lh3.googleusercontent.com/a/abc123')
  })

  test('an account Google reports no picture for leaves the key off the profile', () => {
    const profile = mapGoogleProfile({}, { ...claims, picture: undefined })
    assert.equal('picture' in profile, false)
  })

  test('a blank picture claim is treated the same as absent', () => {
    const profile = mapGoogleProfile({}, { ...claims, picture: '   ' })
    assert.equal('picture' in profile, false)
  })
})
