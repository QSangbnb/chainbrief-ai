import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  approvalAfterApprove,
  approvalAfterEdit,
  approvalInitialState,
  createDeterministicFallbackDraft,
  normalizeSocialPostText,
  sanitizeSocialDraft,
  shortenThreadsDraft,
  shortenXDraft,
} from '../dist/lib/social.js'

const identity = {
  name: 'Orbio',
  symbol: 'ORBIO',
  officialDomain: 'orbio.so',
  blockchain: 'Robinhood Chain',
  chainId: '4663',
  contractAddress: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
}

const report = `
Verified identity
- Name: Orbio
- Symbol: ORBIO
- Official domain: orbio.so
- Blockchain: Robinhood Chain
- Chain ID: 4663
- Contract address: 0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3

Executive summary
- Orbio is researched against its official domain and supplied Robinhood Chain contract.
- The report treats weakly sourced claims as unverified instead of confirmed facts.

Risks and unverifiable claims
- Information unavailable from official sources should remain unverified.
`

const serializedBinanceFixture =
  '{"post":"Orbio (ORBIO) research note.\\n\\nVerified identity points to orbio.so on Robinhood Chain.\\n\\nThe report treats weakly sourced claims as unverified. Not financial advice."}'

test('allows valid paraphrasing without unsupported hard facts', () => {
  const result = sanitizeSocialDraft({
    draft: 'Orbio is a cautious research read: start with its official domain and Robinhood Chain identity, then separate verified details from weaker claims. NFA.',
    identity,
    report,
    language: 'en',
    channel: 'x',
  })

  assert.equal(result.changed, false)
  assert.match(result.draft, /cautious research read/)
})

test('removes only sentences with unsupported numbers', () => {
  const result = sanitizeSocialDraft({
    draft:
      'Orbio is researched against its official domain and Robinhood Chain contract. A security score of 51/100 and a 2 day pool age need attention. NFA.',
    identity,
    report,
    language: 'en',
    channel: 'binance',
  })

  assert.equal(result.removedReasons.includes('unsupported_number'), true)
  assert.match(result.draft, /official domain/)
  assert.doesNotMatch(result.draft, /51\/100|2 day/)
})

test('removes unsupported contract addresses without rejecting the whole draft', () => {
  const result = sanitizeSocialDraft({
    draft:
      'Orbio identity is tied to orbio.so on Robinhood Chain. Review this other address 0x1111111111111111111111111111111111111111 before acting.',
    identity,
    report,
    language: 'en',
    channel: 'binance',
  })

  assert.equal(result.removedReasons.includes('unsupported_contract'), true)
  assert.match(result.draft, /orbio\.so/)
  assert.doesNotMatch(result.draft, /0x1111111111111111111111111111111111111111/)
})

test('creates a safe deterministic fallback when cleaning leaves too little text', () => {
  const result = sanitizeSocialDraft({
    draft: 'Security score 51/100. Pool age 2 days.',
    identity,
    report,
    language: 'en',
    channel: 'x',
  })

  assert.equal(result.usedFallback, true)
  assert.match(result.draft, /Orbio \(ORBIO\)/)
  assert.match(result.draft, /orbio\.so/)
  assert.equal([...result.draft].length <= 280, true)
})

test('deterministic fallback uses verified identity and displayed report only', () => {
  const draft = createDeterministicFallbackDraft({
    identity,
    report,
    language: 'en',
    channel: 'binance',
  })

  assert.match(draft, /Orbio \(ORBIO\)/)
  assert.match(draft, /orbio\.so/)
  assert.match(draft, /Robinhood Chain/)
  assert.doesNotMatch(draft, /51\/100|Solana|pikamoon/)
})

test('shortens X drafts deterministically to 280 characters', () => {
  const draft = shortenXDraft(
    'Orbio is researched against its official domain and supplied Robinhood Chain contract. '.repeat(8),
  )

  assert.equal([...draft].length <= 280, true)
})

test('shortens Threads drafts deterministically to 500 characters', () => {
  const draft = shortenThreadsDraft(
    'Orbio is researched against its official domain and supplied Robinhood Chain contract. '.repeat(12),
  )

  assert.equal([...draft].length <= 500, true)
})

test('normalizes serialized Binance Square JSON into clean post text', () => {
  const draft = normalizeSocialPostText(serializedBinanceFixture)

  assert.match(draft, /^Orbio \(ORBIO\) research note\./)
  assert.match(draft, /\n\nVerified identity points/)
  assert.doesNotMatch(draft, /"post"|^\{|\}$|\\n/)
})

test('normalizes supported social response shapes', () => {
  const plain = 'Plain post text.\n\nSecond paragraph.'
  const object = { post: plain }
  const jsonString = JSON.stringify(plain)
  const fenced = `\`\`\`json\n${serializedBinanceFixture}\n\`\`\``
  const stringifiedObject = JSON.stringify(serializedBinanceFixture)
  const escapedJson = serializedBinanceFixture.replace(/"/g, '\\"')

  assert.equal(normalizeSocialPostText(plain), plain)
  assert.equal(normalizeSocialPostText(object), plain)
  assert.equal(normalizeSocialPostText(jsonString), plain)
  assert.equal(normalizeSocialPostText(fenced), normalizeSocialPostText(serializedBinanceFixture))
  assert.equal(normalizeSocialPostText(stringifiedObject), normalizeSocialPostText(serializedBinanceFixture))
  assert.equal(normalizeSocialPostText(escapedJson), normalizeSocialPostText(serializedBinanceFixture))
})

test('validates normalized post text instead of serialized wrapper', () => {
  const normalized = normalizeSocialPostText(serializedBinanceFixture)
  const result = sanitizeSocialDraft({
    draft: normalized,
    identity,
    report,
    language: 'en',
    channel: 'binance',
  })

  assert.equal(result.usedFallback, false)
  assert.doesNotMatch(result.draft, /"post"|\\n|\{|\}/)
  assert.match(result.draft, /\n\nVerified identity points/)
})

test('social draft errors are isolated from the completed report UI', async () => {
  const appSource = await readFile('src/public/app.js', 'utf8')

  assert.match(appSource, /showSocialError\(error/)
  assert.match(appSource, /The research report remains available/)
  assert.doesNotMatch(appSource, /catch \(error\) \{\s*showError\(error\)\s*\} finally \{\s*setSocialButtonsDisabled/)
})

test('Vietnamese draft interface labels use full accents', async () => {
  const appSource = await readFile('src/public/app.js', 'utf8')

  assert.match(appSource, /Bản nháp – cần phê duyệt/)
  assert.match(appSource, /Bản nháp đã được phê duyệt/)
  assert.match(appSource, /Nền tảng/)
  assert.match(appSource, /ký tự/)
})

test('approval state starts locked, approves copy, and editing resets copy', () => {
  assert.deepEqual(approvalInitialState(), {
    approved: false,
    copyEnabled: false,
    label: 'Draft - approval required',
  })
  assert.deepEqual(approvalAfterApprove(), {
    approved: true,
    copyEnabled: true,
    label: 'Approved draft',
  })
  assert.deepEqual(approvalAfterEdit(), approvalInitialState())
})
