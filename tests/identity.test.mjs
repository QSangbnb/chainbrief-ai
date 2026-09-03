import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DisambiguationCandidate,
  detectIdentityConflict,
  extractVerifiedIdentityFromText,
  identityFromConstraints,
  parseIdentityHint,
  splitChainAndId,
} from '../dist/lib/identity.js'

test('same-name candidates preserve distinct identities for disambiguation', () => {
  const candidates = DisambiguationCandidate.array().parse([
    {
      name: 'Example',
      blockchain: 'Solana',
      contractAddress: 'not verified',
      domain: 'example-games.test',
    },
    {
      name: 'Example',
      blockchain: 'Robinhood Chain',
      contractAddress: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
      domain: 'example.test',
    },
  ])

  assert.equal(candidates.length, 2)
  assert.notEqual(candidates[0].blockchain, candidates[1].blockchain)
  assert.notEqual(candidates[0].domain, candidates[1].domain)
})

test('detects blockchain and contract conflicts against supplied identity', () => {
  const constraints = parseIdentityHint(`
    https://example.test
    Robinhood Chain
    0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3
  `)

  const conflict = detectIdentityConflict({
    text: 'The project is deployed on Solana at 0x1111111111111111111111111111111111111111.',
    sourceUrls: ['https://example.test/docs'],
    identity: identityFromConstraints(constraints),
    constraints,
  })

  assert.match(conflict ?? '', /contract|blockchain/)
})

test('detects official-domain conflicts against supplied identity', () => {
  const constraints = parseIdentityHint('Official URL: https://example.test')

  const conflict = detectIdentityConflict({
    text: 'Official domain: unrelated.test',
    sourceUrls: ['https://unrelated.test/docs'],
    identity: {
      name: 'Example',
      symbol: null,
      officialDomain: 'unrelated.test',
      blockchain: 'not verified',
      chainId: null,
      contractAddress: null,
    },
    constraints,
  })

  assert.match(conflict ?? '', /domain|sources/)
})

test('canonicalizes supplied official URLs to domain identity constraints', () => {
  const constraints = parseIdentityHint('Official URL: https://www.orbio.so/dashboard')

  assert.equal(constraints.officialDomain, 'orbio.so')
})

test('identity from constraints never uses the whole research question as the name', () => {
  const constraints = parseIdentityHint(`
    https://www.orbio.so/dashboard
    Robinhood Chain
    0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3
  `)
  const identity = identityFromConstraints(constraints)

  assert.equal(identity.name, null)
  assert.equal(identity.officialDomain, 'orbio.so')
  assert.equal(identity.blockchain, 'Robinhood Chain')
  assert.equal(identity.contractAddress, '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3')
})

test('extracts verified identity from mocked report before identity section removal', () => {
  const fixture = `
## Danh tính đã xác minh
- **Tên:** Orbio
- **Ký hiệu:** ORBIO
- **Tên miền chính thức:** https://www.orbio.so/dashboard
- **Blockchain:** Robinhood Chain (Chain ID 4663)
- **Địa chỉ hợp đồng:** 0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3

## Tóm tắt điều hành
- Orbio là một dự án cần được đối chiếu bằng nguồn chính thức.
`

  const identity = extractVerifiedIdentityFromText(fixture, ['https://www.orbio.so'])

  assert.deepEqual(identity, {
    name: 'Orbio',
    symbol: 'ORBIO',
    officialDomain: 'orbio.so',
    blockchain: 'Robinhood Chain',
    chainId: '4663',
    contractAddress: '0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3',
  })
})

test('splits chain names and chain IDs from combined values', () => {
  assert.deepEqual(splitChainAndId('Robinhood Chain (Chain ID 4663)'), {
    blockchain: 'Robinhood Chain',
    chainId: '4663',
  })
})
