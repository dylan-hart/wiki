import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildEndSessionUrl } from './endSessionUrl.ts'

describe('buildEndSessionUrl', () => {
  test('is null for an empty, missing, non-string or unparseable URL', () => {
    for (const value of [undefined, null, '', '   ', 42, 'not a url', '/relative/logout']) {
      assert.equal(buildEndSessionUrl(value, { postLogoutRedirectUri: 'https://w.example/' }), null)
    }
  })

  test('is null for a non-http(s) URL', () => {
    for (const value of ['javascript:alert(1)', 'ftp://idp.example/logout', 'data:text/plain,x']) {
      assert.equal(buildEndSessionUrl(value), null)
    }
  })

  test('appends both parameters, encoded', () => {
    const out = buildEndSessionUrl('https://idp.example/logout', {
      idTokenHint: 'a.b.c',
      postLogoutRedirectUri: 'https://wiki.example/login?next=/a b&x=1'
    })!
    const url = new URL(out)
    assert.equal(url.origin + url.pathname, 'https://idp.example/logout')
    assert.equal(url.searchParams.get('id_token_hint'), 'a.b.c')
    assert.equal(
      url.searchParams.get('post_logout_redirect_uri'),
      'https://wiki.example/login?next=/a b&x=1'
    )
    assert.ok(out.includes('post_logout_redirect_uri=https%3A%2F%2Fwiki.example%2Flogin'))
    assert.ok(!out.includes(' '))
  })

  test('preserves an existing query string', () => {
    const out = buildEndSessionUrl('https://idp.example/logout?client_id=abc&tenant=t%201', {
      idTokenHint: 'tok'
    })!
    const url = new URL(out)
    assert.equal(url.searchParams.get('client_id'), 'abc')
    assert.equal(url.searchParams.get('tenant'), 't 1')
    assert.equal(url.searchParams.get('id_token_hint'), 'tok')
  })

  test('omits each parameter that is not provided', () => {
    assert.equal(buildEndSessionUrl('https://idp.example/logout'), 'https://idp.example/logout')
    assert.equal(
      buildEndSessionUrl('https://idp.example/logout', { idTokenHint: 'tok' }),
      'https://idp.example/logout?id_token_hint=tok'
    )
    assert.equal(
      buildEndSessionUrl('http://idp.example/logout', {
        postLogoutRedirectUri: 'https://w.example/'
      }),
      'http://idp.example/logout?post_logout_redirect_uri=https%3A%2F%2Fw.example%2F'
    )
    assert.equal(
      buildEndSessionUrl('https://idp.example/logout', {
        idTokenHint: '',
        postLogoutRedirectUri: ''
      }),
      'https://idp.example/logout'
    )
  })
})
