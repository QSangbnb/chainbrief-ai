import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('workspace migration protects per-account records with RLS', async () => {
  const migration = await readFile('supabase/migrations/20260908090000_chainbrief_workspace.sql', 'utf8')

  assert.match(migration, /alter table public\.briefs enable row level security/i)
  assert.match(migration, /alter table public\.watchlist enable row level security/i)
  assert.match(migration, /auth\.uid\(\) = user_id/)
  assert.match(migration, /revoke all on public\.briefs from anon/i)
  assert.match(migration, /get_shared_brief\(p_slug text\)/)
  assert.match(migration, /security definer/i)
  assert.match(migration, /grant execute on function public\.get_shared_brief\(text\) to anon, authenticated/i)
})

test('workspace API keeps Supabase access scoped to the signed-in bearer token', async () => {
  const [server, storage] = await Promise.all([
    readFile('src/server.ts', 'utf8'),
    readFile('src/lib/storage.ts', 'utf8'),
  ])

  assert.match(server, /\/api\/briefs/)
  assert.match(server, /\/api\/watchlist/)
  assert.doesNotMatch(server, /\/api\/admin\/overview/)
  assert.match(storage, /extractBearerToken\(authorization\)/)
  assert.match(storage, /headers\.set\('authorization', `Bearer \$\{token\}`\)/)
  assert.doesNotMatch(server + storage, /SUPABASE_SERVICE_ROLE_KEY/)
})

test('workspace UI exposes history, exports, watchlist, and Threads without unsafe HTML', async () => {
  const [html, app] = await Promise.all([
    readFile('src/public/index.html', 'utf8'),
    readFile('src/public/app.js', 'utf8'),
  ])

  for (const id of ['history-view', 'watchlist-view', 'download-report', 'print-report', 'share-report']) {
    assert.match(html, new RegExp(`id="${id}"`))
  }
  assert.match(html, /data-channel="threads"/)
  assert.doesNotMatch(html, /data-view="admin"|id="admin-view"/)
  assert.match(app, /new window\.Blob/)
  assert.match(app, /navigator\.clipboard\.writeText/)
  assert.doesNotMatch(html + app, /innerHTML/)
})
