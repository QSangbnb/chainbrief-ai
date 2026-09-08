import test from 'node:test'
import assert from 'node:assert/strict'

import {
  authenticateSupabaseRequest,
  extractBearerToken,
  getSupabaseAuthConfig,
} from '../dist/lib/auth.js'

const env = {
  SUPABASE_URL: 'https://project-ref.supabase.co/',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
}

test('reads only the public Supabase authentication configuration', () => {
  assert.deepEqual(getSupabaseAuthConfig(env), {
    url: 'https://project-ref.supabase.co',
    publishableKey: 'sb_publishable_test',
  })
  assert.equal(getSupabaseAuthConfig({}), null)
  assert.equal(getSupabaseAuthConfig({ ...env, SUPABASE_URL: 'javascript:alert(1)' }), null)
})

test('extracts strict bearer tokens', () => {
  assert.equal(extractBearerToken('Bearer signed.jwt.token'), 'signed.jwt.token')
  assert.equal(extractBearerToken('bearer token'), 'token')
  assert.equal(extractBearerToken('Basic credentials'), null)
  assert.equal(extractBearerToken(undefined), null)
})

test('rejects paid requests without a session before making a network call', async () => {
  let called = false
  const result = await authenticateSupabaseRequest(undefined, {
    env,
    fetchImpl: async () => {
      called = true
      return new globalThis.Response()
    },
  })

  assert.equal(called, false)
  assert.deepEqual(result, {
    ok: false,
    status: 401,
    message: 'Sign in with email or Google to use research.',
    logMessage: 'Missing bearer token',
  })
})

test('verifies the bearer token with Supabase and returns a minimal user', async () => {
  let request
  const result = await authenticateSupabaseRequest('Bearer valid-token', {
    env,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return globalThis.Response.json({ id: 'user-123', email: 'member@example.com', role: 'authenticated' })
    },
  })

  assert.equal(request.url, 'https://project-ref.supabase.co/auth/v1/user')
  assert.equal(request.options.headers.apikey, 'sb_publishable_test')
  assert.equal(request.options.headers.authorization, 'Bearer valid-token')
  assert.deepEqual(result, {
    ok: true,
    user: { id: 'user-123', email: 'member@example.com' },
  })
})

test('fails closed when Supabase rejects or cannot verify a session', async () => {
  const rejected = await authenticateSupabaseRequest('Bearer expired', {
    env,
    fetchImpl: async () => new globalThis.Response('', { status: 401 }),
  })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.status, 401)

  const unavailable = await authenticateSupabaseRequest('Bearer valid-token', {
    env,
    fetchImpl: async () => {
      throw new Error('network unavailable')
    },
  })
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.status, 503)
})
