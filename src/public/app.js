import { createAuthClient } from './auth.js'

const form = document.querySelector('#research-form')
const queryInput = document.querySelector('#query')
const identityHintInput = document.querySelector('#identity-hint')
const accessCodeInput = document.querySelector('#access-code')
const accessCodeLabel = document.querySelector('label[for="access-code"]')
const formError = document.querySelector('#form-error')
const researchButton = document.querySelector('#research-button')
const emptyState = document.querySelector('#empty-state')
const loadingState = document.querySelector('#loading-state')
const reportState = document.querySelector('#report-state')
const errorState = document.querySelector('#error-state')
const reportEl = document.querySelector('#report')
const copyReportButton = document.querySelector('#copy-report')
const downloadReportButton = document.querySelector('#download-report')
const printReportButton = document.querySelector('#print-report')
const shareReportButton = document.querySelector('#share-report')
const watchReportButton = document.querySelector('#watch-report')
const reportGeneratedAt = document.querySelector('#report-generated-at')
const socialButtons = document.querySelectorAll('[data-channel]')
const socialPanel = document.querySelector('#social-panel')
const approvalCopy = document.querySelector('#approval-copy')
const socialError = document.querySelector('#social-error')
const socialPost = document.querySelector('#social-post')
const approveButton = document.querySelector('#approve-button')
const copyPostButton = document.querySelector('#copy-post')
const draftStatus = document.querySelector('#draft-status')
const draftPlatform = document.querySelector('#draft-platform')
const draftCount = document.querySelector('#draft-count')
const authButton = document.querySelector('#auth-button')
const authButtonLabel = document.querySelector('#auth-button-label')
const authGate = document.querySelector('#auth-gate')
const authGateLabel = document.querySelector('#auth-gate-label')
const authModal = document.querySelector('#auth-modal')
const authBackdrop = document.querySelector('#auth-backdrop')
const authCard = document.querySelector('.auth-card')
const authClose = document.querySelector('#auth-close')
const authFormView = document.querySelector('#auth-form-view')
const accountView = document.querySelector('#account-view')
const accountAvatar = document.querySelector('#account-avatar')
const accountEmail = document.querySelector('#account-email')
const googleSignIn = document.querySelector('#google-sign-in')
const signInTab = document.querySelector('#sign-in-tab')
const signUpTab = document.querySelector('#sign-up-tab')
const emailAuthForm = document.querySelector('#email-auth-form')
const authEmail = document.querySelector('#auth-email')
const authPassword = document.querySelector('#auth-password')
const emailAuthSubmit = document.querySelector('#email-auth-submit')
const authMessage = document.querySelector('#auth-message')
const signOutButton = document.querySelector('#sign-out-button')
const workspaceTabs = document.querySelectorAll('[data-view]')
const appViews = document.querySelectorAll('.app-view')
const adminTab = document.querySelector('#admin-tab')
const historySearch = document.querySelector('#history-search')
const historyMessage = document.querySelector('#history-message')
const historyList = document.querySelector('#history-list')
const watchlistMessage = document.querySelector('#watchlist-message')
const watchlistList = document.querySelector('#watchlist-list')
const refreshAdminButton = document.querySelector('#refresh-admin')
const adminMessage = document.querySelector('#admin-message')
const adminMetrics = document.querySelector('#admin-metrics')
const sharedNotice = document.querySelector('#shared-notice')
const sharedTitle = document.querySelector('#shared-title')
const toast = document.querySelector('#toast')

let currentReportText = ''
let currentIdentity = null
let currentBriefId = null
let currentBriefTitle = ''
let currentGeneratedAt = null
let pendingPost = ''
let draftApproved = false
let currentSocialChannel = null
let authClient = null
let currentUser = null
let currentUserIsAdmin = false
let authMode = 'sign-in'
let authConfigurationError = ''
let toastTimer = null
let historySearchTimer = null

initializeApp()

authButton.addEventListener('click', () => openAuthModal())
authClose.addEventListener('click', closeAuthModal)
authBackdrop.addEventListener('click', closeAuthModal)
signInTab.addEventListener('click', () => setAuthMode('sign-in'))
signUpTab.addEventListener('click', () => setAuthMode('sign-up'))
googleSignIn.addEventListener('click', () => {
  if (!authClient) {
    setAuthMessage(authConfigurationError || 'Sign-in is not available yet.', true)
    return
  }
  googleSignIn.disabled = true
  authClient.signInWithGoogle()
})
emailAuthForm.addEventListener('submit', handleEmailAuth)
signOutButton.addEventListener('click', handleSignOut)
for (const tab of workspaceTabs) tab.addEventListener('click', () => showAppView(tab.dataset.view))
historySearch.addEventListener('input', () => {
  window.clearTimeout(historySearchTimer)
  historySearchTimer = window.setTimeout(() => loadHistory(historySearch.value.trim()), 250)
})
refreshAdminButton.addEventListener('click', loadAdminOverview)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !authModal.classList.contains('hidden')) closeAuthModal()
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  if (!currentUser) {
    formError.textContent = 'Sign in with email or Google before starting research.'
    openAuthModal()
    return
  }
  const query = queryInput.value.trim()
  const identityHint = identityHintInput.value.trim()
  const language = new FormData(form).get('language')

  if (query.length < 2) {
    formError.textContent = 'Enter a token, contract, project, or research question.'
    return
  }

  formError.textContent = ''
  setResearchState('loading')
  pendingPost = ''
  currentSocialChannel = null
  socialPanel.classList.add('hidden')
  researchButton.disabled = true

  try {
    const response = await fetch('/api/research', {
      method: 'POST',
      headers: await paidRequestHeaders(),
      body: JSON.stringify({ query, identityHint, language }),
    })
    const body = await readJsonResponse(response, 'The research service returned an empty or invalid response.')
    if (response.status === 401) handleExpiredSession(body.error)
    if (!response.ok) throw new Error(body.error ?? 'Research failed.')

    currentBriefId = body.savedBrief?.id || null
    currentBriefTitle = body.savedBrief?.title || query
    currentGeneratedAt = body.savedBrief?.created_at || new Date().toISOString()
    currentReportText = renderReport(body.result)
    updateReportActions()
    setResearchState('success')
    if (body.savedBrief) loadHistory(historySearch.value.trim(), true)
    else showToast('Report created. Saved history will appear after the database migration is installed.')
  } catch (error) {
    showError(error)
  } finally {
    researchButton.disabled = false
  }
})

for (const button of socialButtons) {
  button.addEventListener('click', async () => {
    await generateSocialPost(button)
  })
}

async function generateSocialPost(button) {
  if (!currentReportText || !currentIdentity) return
  if (!currentUser) {
    openAuthModal('Sign in again to generate a social draft.')
    return
  }
  setSocialButtonsDisabled(true)
  const previousText = button.textContent
  button.textContent = 'Generating...'
  resetSocialDraftMessage()
  socialPanel.classList.add('hidden')

  try {
    const language = new FormData(form).get('language')
    const response = await fetch('/api/social', {
      method: 'POST',
      headers: await paidRequestHeaders(),
      body: JSON.stringify({ identity: currentIdentity, report: currentReportText, language, channel: button.dataset.channel }),
    })
    const body = await readJsonResponse(response, 'The drafting service returned an empty or invalid response.')
    if (response.status === 401) handleExpiredSession(body.error)
    if (!response.ok) throw new Error(body.error ?? 'Post generation failed.')

    pendingPost = body.draft
    currentSocialChannel = button.dataset.channel
    approvalCopy.textContent = body.notice
    socialPost.value = pendingPost
    draftPlatform.textContent = localized(
      button.dataset.channel === 'x' ? 'platformX' : button.dataset.channel === 'threads' ? 'platformThreads' : 'platformBinance',
    )
    setDraftApproval(false)
    updateDraftCount()
    socialPanel.classList.remove('hidden')
  } catch (error) {
    showSocialError(error, button.dataset.channel)
  } finally {
    setSocialButtonsDisabled(false)
    button.textContent = previousText
  }
}

approveButton.addEventListener('click', () => {
  pendingPost = socialPost.value
  setDraftApproval(true)
})

socialPost.addEventListener('input', () => {
  pendingPost = socialPost.value
  updateDraftCount()
  if (draftApproved) setDraftApproval(false)
})

copyReportButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(currentReportText)
  flash(copyReportButton, 'Copied')
})

downloadReportButton.addEventListener('click', downloadCurrentReport)
printReportButton.addEventListener('click', () => window.print())
shareReportButton.addEventListener('click', shareCurrentReport)
watchReportButton.addEventListener('click', addCurrentReportToWatchlist)

copyPostButton.addEventListener('click', async () => {
  if (!draftApproved) return
  await navigator.clipboard.writeText(socialPost.value)
  flash(copyPostButton, 'Copied')
})

function renderReport(report) {
  reportEl.replaceChildren()

  if (report.mode === 'structured') {
    setSocialToolsVisible(true)
    currentIdentity = report.identity
    renderVerifiedIdentity(report.identity, currentLanguage())
    renderStructuredReport(report.report, currentLanguage())
    return collectReportText()
  }

  if (report.mode === 'disambiguation') {
    setSocialToolsVisible(false)
    currentIdentity = null
    renderDisambiguation(report)
    return collectReportText()
  }

  setSocialToolsVisible(true)
  currentIdentity = report.identity
  renderVerifiedIdentity(report.identity, currentLanguage())
  renderMarkdownReport(report.markdown)
  if (report.sourceLinks.length > 0) renderSourceLinks(report.sourceLinks)
  return collectReportText()
}

function renderStructuredReport(report, language) {
  const labels =
    language === 'vi'
      ? {
          summary: 'Tóm tắt điều hành',
          facts: 'Thông tin chính',
          technology: 'Công nghệ và trường hợp sử dụng',
          token: 'Thông tin token',
          positives: 'Tín hiệu tích cực',
          risks: 'Rủi ro và tuyên bố chưa thể xác minh',
          sources: 'Nguồn',
          notice: 'Lưu ý không phải lời khuyên tài chính',
          noToken: 'Không tìm thấy dữ liệu token đáng tin cậy.',
          noPositive: 'Chưa xác minh được tín hiệu tích cực rõ ràng.',
        }
      : {
          summary: 'Executive summary',
          facts: 'Key facts',
          technology: 'Technology and use case',
          token: 'Token information',
          positives: 'Positive signals',
          risks: 'Risks and unverifiable claims',
          sources: 'Sources',
          notice: 'Not financial advice',
          noToken: 'No reliable token data found.',
          noPositive: 'No clear positive signals verified.',
        }
  const sections = [
    [labels.summary, report.executiveSummary],
    [labels.facts, report.keyFacts],
    [labels.technology, report.technologyAndUseCase],
    [labels.token, report.tokenInformation.length ? report.tokenInformation : [labels.noToken]],
    [labels.positives, report.positiveSignals.length ? report.positiveSignals : [labels.noPositive]],
    [labels.risks, report.risksAndUnverifiableClaims],
    [labels.sources, report.sourceLinks],
    [labels.notice, [report.notFinancialAdvice]],
  ]

  for (const [title, items] of sections) {
    const section = createSection(title)
    const list = document.createElement('ul')

    for (const item of items) {
      const listItem = document.createElement('li')
      if (title === labels.sources) {
        appendSourceLink(listItem, item)
      } else {
        appendInlineFormatting(listItem, item)
      }
      list.append(listItem)
    }

    section.append(list)
    reportEl.append(section)
  }
}

function renderVerifiedIdentity(identity, language) {
  const labels =
    language === 'vi'
      ? {
          title: 'Danh tính đã xác minh',
          name: 'Tên',
          symbol: 'Ký hiệu',
          domain: 'Tên miền chính thức',
          chain: 'Blockchain',
          chainId: 'Chain ID',
          contract: 'Địa chỉ hợp đồng',
          notVerified: 'chưa xác minh',
        }
      : {
          title: 'Verified identity',
          name: 'Name',
          symbol: 'Symbol',
          domain: 'Official domain',
          chain: 'Blockchain',
          chainId: 'Chain ID',
          contract: 'Contract address',
          notVerified: 'not verified',
        }
  const section = createSection(labels.title)
  section.classList.add('identity-panel')
  const list = document.createElement('dl')
  const rows = [
    [labels.name, identity.name],
    [labels.symbol, identity.symbol],
    [labels.domain, identity.officialDomain],
    [labels.chain, identity.blockchain],
    [labels.chainId, identity.chainId],
    [labels.contract, identity.contractAddress],
  ].filter(([, value]) => Boolean(value))

  if (rows.length === 0) return

  for (const [label, value] of rows) {
    const term = document.createElement('dt')
    term.textContent = label
    const description = document.createElement('dd')
    description.textContent = value
    list.append(term, description)
  }

  section.append(list)
  reportEl.append(section)
}

function renderDisambiguation(result) {
  const section = createSection('Identity needs confirmation')
  const intro = document.createElement('p')
  intro.textContent = result.question
  section.append(intro)

  const list = document.createElement('ul')
  for (const candidate of result.candidates) {
    const item = document.createElement('li')
    item.textContent = `${candidate.name} | chain: ${candidate.blockchain} | contract: ${
      candidate.contractAddress || 'not verified'
    } | domain: ${candidate.domain}`
    list.append(item)
  }

  section.append(list)
  reportEl.append(section)
}

function renderMarkdownReport(markdown) {
  let activeSection = null
  let activeList = null

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    if (/^-{3,}$/.test(line)) {
      activeList = null
      const separator = document.createElement('hr')
      reportEl.append(separator)
      continue
    }

    const heading = line.match(/^#{1,4}\s+(.+)$/) ?? line.match(/^\*\*(.+?)\*\*:?$/)
    if (heading) {
      activeSection = createSection(stripMarkdownMarkers(heading[1]))
      activeList = null
      reportEl.append(activeSection)
      continue
    }

    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      if (!activeSection) {
        activeSection = createSection('Report')
        reportEl.append(activeSection)
      }
      if (!activeList) {
        activeList = document.createElement('ul')
        activeSection.append(activeList)
      }
      const listItem = document.createElement('li')
      appendInlineFormatting(listItem, bullet[1])
      activeList.append(listItem)
      continue
    }

    activeList = null
    if (!activeSection) {
      activeSection = document.createElement('section')
      activeSection.className = 'report-section'
      reportEl.append(activeSection)
    }
    const paragraph = document.createElement('p')
    appendInlineFormatting(paragraph, line)
    activeSection.append(paragraph)
  }
}

function renderSourceLinks(sourceLinks) {
  const section = createSection('Sources')
  const list = document.createElement('ul')

  for (const source of sourceLinks) {
    const item = document.createElement('li')
    appendSourceLink(item, source)
    list.append(item)
  }

  section.append(list)
  reportEl.append(section)
}

function createSection(title) {
  const section = document.createElement('section')
  section.className = 'report-section'
  const heading = document.createElement('h3')
  heading.textContent = stripMarkdownMarkers(title)
  section.append(heading)
  return section
}

function appendSourceLink(container, source) {
  container.classList.add('source-link-row')
  const badge = document.createElement('span')
  badge.className = 'source-badge'
  badge.textContent = classifySource(source.url)
  const anchor = document.createElement('a')
  anchor.href = source.url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer'
  anchor.textContent = source.title && source.title !== 'Source' ? source.title : source.url
  container.append(badge, anchor)
}

function classifySource(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '')
    const official = normalizeHostname(currentIdentity?.officialDomain)
    if (official && (hostname === official || hostname.endsWith('.' + official))) {
      return currentLanguage() === 'vi' ? 'Chính thức' : 'Official'
    }
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'Repository'
    if (/^(docs?|developer|developers|support)\./.test(hostname)) return 'Docs'
    if (/(etherscan|bscscan|arbiscan|polygonscan|snowtrace|solscan|blockchair)/.test(hostname)) return 'Explorer'
    return currentLanguage() === 'vi' ? 'Nguồn ngoài' : 'External'
  } catch {
    return currentLanguage() === 'vi' ? 'Nguồn' : 'Source'
  }
}

function normalizeHostname(value) {
  if (!value) return ''
  try {
    return new URL(value.includes('://') ? value : 'https://' + value).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return String(value).toLowerCase().replace(/^www\./, '').split('/')[0]
  }
}

function appendInlineFormatting(container, text) {
  const tokenPattern = /(\*\*[^*]+\*\*|https?:\/\/[^\s<>)\]}"]+)/g
  let lastIndex = 0

  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > lastIndex) container.append(document.createTextNode(text.slice(lastIndex, match.index)))

    if (match[0].startsWith('http')) {
      const url = match[0].replace(/[.,;:!?]+$/, '')
      const trailing = match[0].slice(url.length)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.target = '_blank'
      anchor.rel = 'noreferrer'
      anchor.textContent = url
      container.append(anchor)
      if (trailing) container.append(document.createTextNode(trailing))
    } else {
      const strong = document.createElement('strong')
      strong.textContent = match[0].slice(2, -2)
      container.append(strong)
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) container.append(document.createTextNode(text.slice(lastIndex)))
}

function stripMarkdownMarkers(text) {
  return String(text)
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/, '')
    .replace(/`/g, '')
    .trim()
}

function collectReportText() {
  return Array.from(reportEl.querySelectorAll('.report-section, hr'))
    .map((node) => {
      if (node.tagName === 'HR') return '---'
      return node.textContent.trim()
    })
    .filter(Boolean)
    .join('\n\n')
}

function setSocialButtonsDisabled(disabled) {
  for (const button of socialButtons) button.disabled = disabled
}

function setSocialToolsVisible(visible) {
  for (const button of socialButtons) button.classList.toggle('hidden', !visible)
}

function setDraftApproval(approved) {
  draftApproved = approved
  draftStatus.textContent = approved ? localized('approvedDraft') : localized('approvalRequired')
  copyPostButton.disabled = !approved
  approveButton.disabled = approved
}

function updateDraftCount() {
  const count = Array.from(socialPost.value).length
  const limit = currentSocialChannel === 'x' ? 280 : currentSocialChannel === 'threads' ? 500 : null
  draftCount.textContent = limit ? localized('charactersWithLimit', `${count} / ${limit}`) : localized('characters', count)
}

function currentLanguage() {
  return new FormData(form).get('language')
}

async function initializeApp() {
  configureDemoAccess()

  try {
    authClient = await createAuthClient()
    try {
      currentUser = await authClient.initialize()
    } catch (error) {
      authConfigurationError = error instanceof Error ? error.message : 'Authentication could not be completed.'
      openAuthModal(authConfigurationError)
    }
  } catch (error) {
    authConfigurationError = error instanceof Error ? error.message : 'Sign-in is not configured.'
  }

  updateAuthUi()
  if (currentUser) await loadAccountCapabilities()

  const sharedSlug = window.location.pathname.match(/^\/share\/([A-Za-z0-9_-]+)$/)?.[1]
  if (sharedSlug) await loadSharedBrief(sharedSlug)
}

async function loadAccountCapabilities() {
  if (!currentUser) return
  try {
    const body = await authenticatedJson('/api/account')
    currentUserIsAdmin = Boolean(body.isAdmin)
    adminTab.classList.toggle('hidden', !currentUserIsAdmin)
  } catch (error) {
    currentUserIsAdmin = false
    adminTab.classList.add('hidden')
    if (error instanceof Error && /session expired/i.test(error.message)) handleExpiredSession(error.message)
  }
}

async function showAppView(view, force = false) {
  if (!force && view !== 'research' && !currentUser) {
    openAuthModal('Sign in to open your saved workspace.')
    return
  }
  if (view === 'admin' && !currentUserIsAdmin) return

  for (const tab of workspaceTabs) tab.classList.toggle('active', tab.dataset.view === view)
  for (const panel of appViews) panel.classList.toggle('hidden', panel.id !== `${view}-view`)
  socialPanel.classList.toggle('hidden', view !== 'research' || !pendingPost)

  if (view === 'history') await loadHistory(historySearch.value.trim())
  if (view === 'watchlist') await loadWatchlist()
  if (view === 'admin') await loadAdminOverview()
}

async function loadHistory(search = '', silent = false) {
  if (!currentUser) return
  if (!silent) historyMessage.textContent = 'Loading saved briefs...'
  try {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    const body = await authenticatedJson(`/api/briefs${params.size ? `?${params}` : ''}`)
    renderHistory(body.briefs || [])
    historyMessage.textContent = body.briefs?.length ? '' : 'No saved briefs yet. Your next completed report will appear here.'
  } catch (error) {
    historyList.replaceChildren()
    historyMessage.textContent = friendlyFeatureError(error)
  }
}

function renderHistory(briefs) {
  historyList.replaceChildren()
  for (const brief of briefs) {
    const card = createFeatureCard(
      brief.title,
      `${formatDate(brief.created_at)} · ${String(brief.language || 'en').toUpperCase()} · ${brief.query}`,
    )
    const open = createActionButton('Open', () => openSavedBrief(brief))
    const rename = createActionButton('Rename', () => renameSavedBrief(brief))
    const share = createActionButton('Share', () => shareBriefById(brief.id))
    const remove = createActionButton('Delete', () => removeSavedBrief(brief), true)
    card.actions.append(open, rename, share, remove)
    historyList.append(card.root)
  }
}

async function openSavedBrief(summary) {
  try {
    const body = await authenticatedJson(`/api/briefs/${summary.id}`)
    const brief = body.brief
    queryInput.value = brief.query || ''
    identityHintInput.value = brief.identity_hint || ''
    const language = document.querySelector(`input[name="language"][value="${brief.language}"]`)
    if (language) language.checked = true
    currentBriefId = brief.id
    currentBriefTitle = brief.title
    currentGeneratedAt = brief.updated_at || brief.created_at
    currentReportText = renderReport(brief.result)
    if (brief.report_text) currentReportText = brief.report_text
    updateReportActions()
    setResearchState('success')
    await showAppView('research', true)
    window.scrollTo({ top: document.querySelector('#research-view').offsetTop - 20, behavior: 'smooth' })
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not open the brief.')
  }
}

async function renameSavedBrief(brief) {
  const title = window.prompt('New brief title', brief.title)?.trim()
  if (!title || title === brief.title) return
  try {
    await authenticatedJson(`/api/briefs/${brief.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
    if (currentBriefId === brief.id) currentBriefTitle = title
    await loadHistory(historySearch.value.trim(), true)
    showToast('Brief renamed.')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not rename the brief.')
  }
}

async function removeSavedBrief(brief) {
  if (!window.confirm(`Delete “${brief.title}”? This cannot be undone.`)) return
  try {
    await authenticatedJson(`/api/briefs/${brief.id}`, { method: 'DELETE' })
    if (currentBriefId === brief.id) currentBriefId = null
    await loadHistory(historySearch.value.trim(), true)
    showToast('Brief deleted.')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not delete the brief.')
  }
}

async function shareCurrentReport() {
  if (!currentBriefId) {
    showToast('Generate or open a saved brief before sharing.')
    return
  }
  await shareBriefById(currentBriefId)
}

async function shareBriefById(id) {
  try {
    const body = await authenticatedJson(`/api/briefs/${id}/share`, { method: 'POST' })
    const url = new URL(body.url, window.location.origin).toString()
    await navigator.clipboard.writeText(url)
    showToast('Public read-only link copied. Anyone with the link can view this report.')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not create a share link.')
  }
}

function downloadCurrentReport() {
  if (!currentReportText) return
  const title = currentBriefTitle || currentIdentity?.name || 'chainbrief-report'
  const markdown = `# ${title}\n\nGenerated: ${formatDate(currentGeneratedAt)}\n\n${currentReportText}\n`
  const blob = new window.Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${safeFilename(title)}.md`
  link.click()
  URL.revokeObjectURL(url)
}

async function addCurrentReportToWatchlist() {
  if (!currentIdentity || !currentUser) return
  const payload = {
    name: currentIdentity.name || currentIdentity.symbol || currentBriefTitle || 'Tracked project',
    symbol: currentIdentity.symbol || null,
    official_domain: currentIdentity.officialDomain || null,
    blockchain: currentIdentity.blockchain || null,
    contract_address: currentIdentity.contractAddress || null,
  }
  try {
    await authenticatedJson('/api/watchlist', { method: 'POST', body: JSON.stringify(payload) })
    showToast('Added to your watchlist.')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not update the watchlist.')
  }
}

async function loadWatchlist() {
  if (!currentUser) return
  watchlistMessage.textContent = 'Loading watchlist...'
  try {
    const body = await authenticatedJson('/api/watchlist')
    renderWatchlist(body.items || [])
    watchlistMessage.textContent = body.items?.length ? '' : 'Your watchlist is empty. Open a report and choose “Add to watchlist”.'
  } catch (error) {
    watchlistList.replaceChildren()
    watchlistMessage.textContent = friendlyFeatureError(error)
  }
}

function renderWatchlist(items) {
  watchlistList.replaceChildren()
  for (const item of items) {
    const facts = [item.symbol, item.blockchain, item.official_domain].filter(Boolean).join(' · ') || 'Verified identity saved'
    const card = createFeatureCard(item.name, facts)
    const refresh = createActionButton('Research update', () => researchWatchlistItem(item))
    const remove = createActionButton('Remove', () => removeWatchlistItem(item), true)
    card.actions.append(refresh, remove)
    watchlistList.append(card.root)
  }
}

function researchWatchlistItem(item) {
  queryInput.value = `What are the latest verified developments, risks, and material changes for ${item.name}?`
  identityHintInput.value = [item.official_domain, item.blockchain, item.contract_address].filter(Boolean).join('\n')
  showAppView('research', true)
  form.requestSubmit()
}

async function removeWatchlistItem(item) {
  try {
    await authenticatedJson(`/api/watchlist/${item.id}`, { method: 'DELETE' })
    await loadWatchlist()
    showToast('Removed from watchlist.')
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Could not remove the watchlist item.')
  }
}

async function loadAdminOverview() {
  if (!currentUserIsAdmin) return
  adminMessage.textContent = 'Loading live service metrics...'
  refreshAdminButton.disabled = true
  try {
    const body = await authenticatedJson('/api/admin/overview')
    renderAdminOverview(body)
    adminMessage.textContent = `Runtime started ${formatDate(body.startedAt)}. Runtime counters reset when Render restarts.`
  } catch (error) {
    adminMetrics.replaceChildren()
    adminMessage.textContent = error instanceof Error ? error.message : 'Could not load the admin overview.'
  } finally {
    refreshAdminButton.disabled = false
  }
}

function renderAdminOverview(data) {
  const researchTotal = (data.metrics?.research?.succeeded || 0) + (data.metrics?.research?.failed || 0)
  const socialTotal = (data.metrics?.social?.succeeded || 0) + (data.metrics?.social?.failed || 0)
  const latencyTotal = (data.metrics?.research?.totalLatencyMs || 0) + (data.metrics?.social?.totalLatencyMs || 0)
  const requestTotal = researchTotal + socialTotal
  const values = [
    ['Active requests', `${data.activePaidRequests || 0} / ${data.concurrencyMax || 0}`],
    ['Research requests', String(researchTotal)],
    ['Social drafts', String(socialTotal)],
    ['Failed requests', String((data.metrics?.research?.failed || 0) + (data.metrics?.social?.failed || 0))],
    ['Average latency', requestTotal ? `${Math.round(latencyTotal / requestTotal / 100) / 10}s` : '—'],
    ['OpenRouter today', formatCredits(data.openrouter?.usageDaily)],
    ['OpenRouter month', formatCredits(data.openrouter?.usageMonthly)],
    ['Key limit remaining', data.openrouter?.limitRemaining == null ? 'No key cap' : formatCredits(data.openrouter.limitRemaining)],
  ]
  adminMetrics.replaceChildren()
  for (const [label, value] of values) {
    const card = document.createElement('div')
    card.className = 'metric-card'
    const name = document.createElement('span')
    name.textContent = label
    const amount = document.createElement('strong')
    amount.textContent = value
    card.append(name, amount)
    adminMetrics.append(card)
  }
}

async function loadSharedBrief(slug) {
  document.body.classList.add('shared-view')
  sharedNotice.classList.remove('hidden')
  setResearchState('loading')
  try {
    const response = await fetch(`/api/shared/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } })
    const body = await readJsonResponse(response, 'The shared report could not be loaded.')
    if (!response.ok) throw new Error(body.error || 'Shared brief not found.')
    const brief = body.brief
    sharedTitle.textContent = brief.title
    currentBriefTitle = brief.title
    currentGeneratedAt = brief.updated_at || brief.created_at
    const language = document.querySelector(`input[name="language"][value="${brief.language}"]`)
    if (language) language.checked = true
    currentReportText = renderReport(brief.result)
    if (brief.report_text) currentReportText = brief.report_text
    updateReportActions()
    setResearchState('success')
  } catch (error) {
    showError(error)
  }
}

function createFeatureCard(title, detail) {
  const root = document.createElement('article')
  root.className = 'feature-card'
  const copy = document.createElement('div')
  const heading = document.createElement('h3')
  heading.textContent = title
  const paragraph = document.createElement('p')
  paragraph.textContent = detail
  copy.append(heading, paragraph)
  const actions = document.createElement('div')
  actions.className = 'feature-card-actions'
  root.append(copy, actions)
  return { root, actions }
}

function createActionButton(label, handler, danger = false) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `secondary${danger ? ' danger-button' : ''}`
  button.textContent = label
  button.addEventListener('click', handler)
  return button
}

async function authenticatedJson(path, options = {}) {
  const token = await authClient?.accessToken()
  if (!token) {
    handleExpiredSession('Your session expired. Please sign in again.')
    throw new Error('Your session expired. Please sign in again.')
  }
  const response = await fetch(path, {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: 'Bearer ' + token,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const body = await readJsonResponse(response, 'The service returned an invalid response.')
  if (response.status === 401) handleExpiredSession(body.error)
  if (!response.ok) throw new Error(body.error || 'The request could not be completed.')
  return body
}

function updateReportActions() {
  reportGeneratedAt.textContent = currentGeneratedAt ? `Evidence checked ${formatDate(currentGeneratedAt)}` : ''
  shareReportButton.disabled = !currentUser || !currentBriefId
  watchReportButton.disabled = !currentUser || !currentIdentity
}

function formatDate(value) {
  if (!value) return 'Unknown date'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat(currentLanguage() === 'vi' ? 'vi-VN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function formatCredits(value) {
  return typeof value === 'number' ? `$${value.toFixed(4)}` : '—'
}

function safeFilename(value) {
  return String(value)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'chainbrief-report'
}

function friendlyFeatureError(error) {
  const message = error instanceof Error ? error.message : ''
  if (/configured|unavailable/i.test(message)) {
    return 'Saved workspace setup is pending. Research and social drafts still work normally.'
  }
  return message || 'This workspace could not be loaded.'
}

function showToast(message) {
  window.clearTimeout(toastTimer)
  toast.textContent = message
  toast.classList.remove('hidden')
  toastTimer = window.setTimeout(() => toast.classList.add('hidden'), 4200)
}

async function handleEmailAuth(event) {
  event.preventDefault()
  if (!authClient) {
    setAuthMessage(authConfigurationError || 'Sign-in is not available yet.', true)
    return
  }

  const email = authEmail.value.trim()
  const password = authPassword.value
  if (!authEmail.validity.valid || !email) {
    setAuthMessage('Enter a valid email address.', true)
    authEmail.focus()
    return
  }
  if (password.length < 8) {
    setAuthMessage('Use a password with at least 8 characters.', true)
    authPassword.focus()
    return
  }

  setAuthControlsDisabled(true)
  setAuthMessage('')
  try {
    if (authMode === 'sign-up') {
      const result = await authClient.signUp(email, password)
      if (!result.session) {
        authPassword.value = ''
        setAuthMode('sign-in')
        setAuthMessage('Account created. Check your email and confirm your address, then sign in.')
        return
      }
      currentUser = authClient.user
    } else {
      currentUser = await authClient.signInWithPassword(email, password)
    }

    authPassword.value = ''
    updateAuthUi()
    await loadAccountCapabilities()
    closeAuthModal()
  } catch (error) {
    setAuthMessage(error instanceof Error ? error.message : 'Authentication failed.', true)
  } finally {
    setAuthControlsDisabled(false)
  }
}

async function handleSignOut() {
  if (!authClient) return
  signOutButton.disabled = true
  try {
    await authClient.signOut()
    currentUser = null
    currentReportText = ''
    currentIdentity = null
    currentBriefId = null
    currentUserIsAdmin = false
    adminTab.classList.add('hidden')
    historyList.replaceChildren()
    watchlistList.replaceChildren()
    socialPanel.classList.add('hidden')
    setResearchState('empty')
    showAppView('research', true)
    updateAuthUi()
    closeAuthModal()
  } finally {
    signOutButton.disabled = false
  }
}

function setAuthMode(mode) {
  authMode = mode
  const signingIn = mode === 'sign-in'
  signInTab.classList.toggle('active', signingIn)
  signUpTab.classList.toggle('active', !signingIn)
  signInTab.setAttribute('aria-selected', String(signingIn))
  signUpTab.setAttribute('aria-selected', String(!signingIn))
  authPassword.autocomplete = signingIn ? 'current-password' : 'new-password'
  emailAuthSubmit.querySelector('span').textContent = signingIn ? 'Sign in with email' : 'Create account'
  setAuthMessage('')
}

function openAuthModal(message = '') {
  const signedIn = Boolean(currentUser)
  authFormView.classList.toggle('hidden', signedIn)
  accountView.classList.toggle('hidden', !signedIn)
  setAuthMessage(message || (!authClient ? authConfigurationError : ''), Boolean(message || !authClient))
  authModal.classList.remove('hidden')
  authModal.setAttribute('aria-hidden', 'false')
  document.body.classList.add('auth-open')
  window.setTimeout(() => {
    if (signedIn) signOutButton.focus()
    else if (authClient) googleSignIn.focus()
    else authCard.focus()
  }, 0)
}

function closeAuthModal() {
  authModal.classList.add('hidden')
  authModal.setAttribute('aria-hidden', 'true')
  document.body.classList.remove('auth-open')
  authButton.focus()
}

function updateAuthUi() {
  const signedIn = Boolean(currentUser)
  authButton.classList.toggle('is-authenticated', signedIn)
  authGate.classList.toggle('is-authenticated', signedIn)
  authButtonLabel.textContent = signedIn ? 'Account' : 'Sign in'

  if (signedIn) {
    const email = currentUser.email || 'Authenticated user'
    authGateLabel.textContent = 'Signed in as ' + email
    accountEmail.textContent = email
    accountAvatar.textContent = email.slice(0, 1).toUpperCase()
  } else {
    authGateLabel.textContent = authConfigurationError || 'Sign in with email or Google to run research.'
    accountEmail.textContent = ''
    accountAvatar.textContent = 'C'
  }
  updateReportActions()
}

function setAuthControlsDisabled(disabled) {
  googleSignIn.disabled = disabled
  signInTab.disabled = disabled
  signUpTab.disabled = disabled
  authEmail.disabled = disabled
  authPassword.disabled = disabled
  emailAuthSubmit.disabled = disabled
}

function setAuthMessage(message, isError = false) {
  authMessage.textContent = message
  authMessage.classList.toggle('is-error', isError)
}

function handleExpiredSession(message) {
  authClient?.clearSession()
  currentUser = null
  updateAuthUi()
  openAuthModal(message || 'Your session expired. Please sign in again.')
}

async function configureDemoAccess() {
  try {
    const response = await fetch('/api/health')
    const body = await readJsonResponse(response, 'Health check returned an invalid response.')
    if (!response.ok) return

    const required = Boolean(body.configuration?.demoAccessCodeRequired)
    accessCodeInput.classList.toggle('hidden', !required)
    accessCodeLabel?.classList.toggle('hidden', !required)
    if (!required) accessCodeInput.value = ''
  } catch {
    // Keep the field visible if the health check is unavailable.
  }
}

async function readJsonResponse(response, fallbackMessage) {
  const text = await response.text()
  if (!text.trim()) throw new Error(`${fallbackMessage} HTTP ${response.status}.`)

  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${fallbackMessage} HTTP ${response.status}.`)
  }
}

async function paidRequestHeaders() {
  const headers = { 'content-type': 'application/json' }
  const token = await authClient?.accessToken()
  if (!token) {
    handleExpiredSession('Your session expired. Please sign in again.')
    throw new Error('Sign in with email or Google to continue.')
  }
  headers.authorization = 'Bearer ' + token
  const accessCode = accessCodeInput.value.trim()
  if (accessCode) headers['x-demo-access-code'] = accessCode
  return headers
}

function setResearchState(state) {
  emptyState.classList.toggle('hidden', state !== 'empty')
  loadingState.classList.toggle('hidden', state !== 'loading')
  reportState.classList.toggle('hidden', state !== 'success')
  errorState.classList.toggle('hidden', state !== 'error')
}

function showError(error) {
  errorState.textContent = error instanceof Error ? error.message : 'Something went wrong.'
  setResearchState('error')
}

function showSocialError(error, channel) {
  pendingPost = ''
  socialPost.value = ''
  currentSocialChannel = channel
  draftPlatform.textContent = localized(
    channel === 'x' ? 'platformX' : channel === 'threads' ? 'platformThreads' : 'platformBinance',
  )
  draftCount.textContent = localized('characters', 0)
  draftStatus.textContent = localized('approvalRequired')
  approvalCopy.textContent = localized('socialFailurePreservesReport')
  socialError.textContent = error instanceof Error ? error.message : localized('socialError')
  setDraftApproval(false)
  socialPanel.classList.remove('hidden')
}

function resetSocialDraftMessage() {
  socialError.textContent = ''
  approvalCopy.textContent = ''
}

function localized(key, value) {
  const isVi = currentLanguage() === 'vi'
  const dictionary = {
    platformX: isVi ? 'Nền tảng: X' : 'Platform: X',
    platformBinance: isVi ? 'Nền tảng: Binance Square' : 'Platform: Binance Square',
    platformThreads: isVi ? 'Nền tảng: Threads' : 'Platform: Threads',
    approvedDraft: isVi ? 'Bản nháp đã được phê duyệt' : 'Approved draft',
    approvalRequired: isVi ? 'Bản nháp – cần phê duyệt' : 'Draft - approval required',
    socialFailurePreservesReport: isVi
      ? 'Báo cáo nghiên cứu vẫn được giữ nguyên. Lỗi này chỉ ảnh hưởng đến bản nháp mạng xã hội.'
      : 'The research report remains available. This error only affects the social draft.',
    socialError: isVi ? 'Không thể tạo bản nháp mạng xã hội an toàn.' : 'Could not create a safe social draft.',
  }
  if (key === 'characters' || key === 'charactersWithLimit') return isVi ? `${value} ký tự` : `${value} characters`
  return dictionary[key]
}

function flash(button, text) {
  const previousNodes = Array.from(button.childNodes, (node) => node.cloneNode(true))
  button.replaceChildren(document.createTextNode(text))
  window.setTimeout(() => {
    button.replaceChildren(...previousNodes)
  }, 900)
}
