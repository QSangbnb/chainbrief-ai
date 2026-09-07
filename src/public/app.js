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

let currentReportText = ''
let currentIdentity = null
let pendingPost = ''
let draftApproved = false

configureDemoAccess()

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const query = queryInput.value.trim()
  const identityHint = identityHintInput.value.trim()
  const language = new FormData(form).get('language')

  if (query.length < 2) {
    formError.textContent = 'Enter a token, contract, project, or research question.'
    return
  }

  formError.textContent = ''
  setResearchState('loading')
  socialPanel.classList.add('hidden')
  researchButton.disabled = true

  try {
    const response = await fetch('/api/research', {
      method: 'POST',
      headers: paidRequestHeaders(),
      body: JSON.stringify({ query, identityHint, language }),
    })
    const body = await readJsonResponse(response, 'The research service returned an empty or invalid response.')
    if (!response.ok) throw new Error(body.error ?? 'Research failed.')

    currentReportText = renderReport(body.result)
    setResearchState('success')
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
  setSocialButtonsDisabled(true)
  const previousText = button.textContent
  button.textContent = 'Generating...'
  resetSocialDraftMessage()
  socialPanel.classList.add('hidden')

  try {
    const language = new FormData(form).get('language')
    const response = await fetch('/api/social', {
      method: 'POST',
      headers: paidRequestHeaders(),
      body: JSON.stringify({ identity: currentIdentity, report: currentReportText, language, channel: button.dataset.channel }),
    })
    const body = await readJsonResponse(response, 'The drafting service returned an empty or invalid response.')
    if (!response.ok) throw new Error(body.error ?? 'Post generation failed.')

    pendingPost = body.draft
    approvalCopy.textContent = body.notice
    socialPost.value = pendingPost
    draftPlatform.textContent =
      button.dataset.channel === 'x' ? localized('platformX') : localized('platformBinance')
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
  const anchor = document.createElement('a')
  anchor.href = source.url
  anchor.target = '_blank'
  anchor.rel = 'noreferrer'
  anchor.textContent = source.url
  container.append(anchor)
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
  draftCount.textContent = localized('characters', Array.from(socialPost.value).length)
}

function currentLanguage() {
  return new FormData(form).get('language')
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

function paidRequestHeaders() {
  const headers = { 'content-type': 'application/json' }
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
  draftPlatform.textContent = channel === 'x' ? localized('platformX') : localized('platformBinance')
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
    approvedDraft: isVi ? 'Bản nháp đã được phê duyệt' : 'Approved draft',
    approvalRequired: isVi ? 'Bản nháp – cần phê duyệt' : 'Draft - approval required',
    socialFailurePreservesReport: isVi
      ? 'Báo cáo nghiên cứu vẫn được giữ nguyên. Lỗi này chỉ ảnh hưởng đến bản nháp mạng xã hội.'
      : 'The research report remains available. This error only affects the social draft.',
    socialError: isVi ? 'Không thể tạo bản nháp mạng xã hội an toàn.' : 'Could not create a safe social draft.',
  }
  if (key === 'characters') return isVi ? `${value} ký tự` : `${value} characters`
  return dictionary[key]
}

function flash(button, text) {
  const previousNodes = Array.from(button.childNodes, (node) => node.cloneNode(true))
  button.replaceChildren(document.createTextNode(text))
  window.setTimeout(() => {
    button.replaceChildren(...previousNodes)
  }, 900)
}
