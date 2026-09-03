import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('server keeps paid endpoint release guards in place', async () => {
  const source = await readFile('src/server.ts', 'utf8')

  assert.match(source, /DEMO_ACCESS_CODE/)
  assert.match(source, /MAX_REQUEST_BYTES/)
  assert.match(source, /RATE_LIMIT_MAX/)
  assert.match(source, /PAID_CONCURRENCY_MAX/)
  assert.match(source, /PAID_REQUEST_TIMEOUT_MS/)
  assert.match(source, /validateUserSuppliedUrls/)
  assert.match(source, /Localhost, private-network, and loopback URLs are not allowed/)
  assert.doesNotMatch(source, /openrouterApiKeyApproximateLength/)
  assert.doesNotMatch(source, /Access-Control-Allow-Origin.*\*/)
})

test('environment example uses placeholders only', async () => {
  const envExample = await readFile('.env.example', 'utf8')

  assert.match(envExample, /^OPENROUTER_API_KEY=$/m)
  assert.match(envExample, /^DEMO_ACCESS_CODE=$/m)
  assert.doesNotMatch(envExample, /sk-or-v1-[A-Za-z0-9_-]+/)
})
