/**
 * Request Identity Service
 *
 * Normalizes Claude request identity data:
 * 1. Stainless fingerprint management - collect and persist x-stainless-* headers.
 * 2. User ID normalization - rewrite metadata.user_id consistently per account strategy.
 */

const crypto = require('crypto')
const logger = require('../utils/logger')
const redisService = require('../models/redis')
const metadataUserIdHelper = require('../utils/metadataUserIdHelper')

const STAINLESS_HEADER_KEYS = [
  'x-stainless-retry-count',
  'x-stainless-timeout',
  'x-stainless-lang',
  'x-stainless-package-version',
  'x-stainless-os',
  'x-stainless-arch',
  'x-stainless-runtime',
  'x-stainless-runtime-version'
]

const STAINLESS_HEADER_CASE_MAP = {
  'x-stainless-retry-count': 'X-Stainless-Retry-Count',
  'x-stainless-timeout': 'X-Stainless-Timeout',
  'x-stainless-lang': 'X-Stainless-Lang',
  'x-stainless-package-version': 'X-Stainless-Package-Version',
  'x-stainless-os': 'X-Stainless-OS',
  'x-stainless-arch': 'X-Stainless-Arch',
  'x-stainless-runtime': 'X-Stainless-Runtime',
  'x-stainless-runtime-version': 'X-Stainless-Runtime-Version'
}

const MIN_FINGERPRINT_FIELDS = 4
const REDIS_KEY_PREFIX = 'fmt_claude_req:stainless_headers:'
const DEFAULT_CLIENT_ID_REWRITE_MODE = 'unified_per_account'
const CLIENT_ID_REWRITE_MODES = new Set([
  'preserve',
  'legacy_global',
  'unified_per_account',
  'unified_per_api_key'
])
const DEFAULT_STAINLESS_FINGERPRINT_TTL_SECONDS = 7 * 24 * 60 * 60

function formatUuidFromSeed(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function hashHex(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex')
}

function safeParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    return null
  }
}

function getRedisClient() {
  if (!redisService || typeof redisService.getClientSafe !== 'function') {
    throw new Error('requestIdentityService: Redis service is not initialized')
  }

  return redisService.getClientSafe()
}

function hasFingerprintValues(fingerprint) {
  return fingerprint && typeof fingerprint === 'object' && Object.keys(fingerprint).length > 0
}

function sanitizeFingerprint(source) {
  if (!source || typeof source !== 'object') {
    return {}
  }

  const normalized = {}
  const lowerCaseSource = {}

  Object.keys(source).forEach((key) => {
    const value = source[key]
    if (value === undefined || value === null || String(value).trim() === '') {
      return
    }
    lowerCaseSource[key.toLowerCase()] = String(value)
  })

  STAINLESS_HEADER_KEYS.forEach((key) => {
    if (lowerCaseSource[key]) {
      normalized[key] = lowerCaseSource[key]
    }
  })

  return normalized
}

function collectFingerprintFromHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  const subset = {}

  Object.keys(headers).forEach((key) => {
    const lowerKey = key.toLowerCase()
    if (STAINLESS_HEADER_KEYS.includes(lowerKey)) {
      subset[lowerKey] = headers[key]
    }
  })

  return sanitizeFingerprint(subset)
}

function removeHeaderCaseInsensitive(target, key) {
  if (!target || typeof target !== 'object') {
    return
  }

  const lowerKey = key.toLowerCase()
  Object.keys(target).forEach((candidate) => {
    if (candidate.toLowerCase() === lowerKey) {
      delete target[candidate]
    }
  })
}

function applyFingerprintToHeaders(headers, fingerprint) {
  if (!headers || typeof headers !== 'object') {
    return headers
  }

  if (!hasFingerprintValues(fingerprint)) {
    return { ...headers }
  }

  const nextHeaders = { ...headers }

  STAINLESS_HEADER_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(fingerprint, key)) {
      return
    }
    removeHeaderCaseInsensitive(nextHeaders, key)
    const properCaseKey = STAINLESS_HEADER_CASE_MAP[key] || key
    nextHeaders[properCaseKey] = fingerprint[key]
  })

  return nextHeaders
}

function getFingerprintTtlSeconds() {
  const parsed = parseInt(process.env.STAINLESS_FINGERPRINT_TTL_SECONDS || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STAINLESS_FINGERPRINT_TTL_SECONDS
}

function persistFingerprint(accountId, fingerprint) {
  if (!accountId || !hasFingerprintValues(fingerprint)) {
    return
  }

  const client = getRedisClient()
  const key = `${REDIS_KEY_PREFIX}${accountId}`
  const serialized = JSON.stringify(fingerprint)
  const ttlSeconds = getFingerprintTtlSeconds()
  const command = client.set(key, serialized, 'EX', ttlSeconds)

  if (command && typeof command.catch === 'function') {
    command.catch((error) => {
      logger.error(
        `requestIdentityService: failed to persist fingerprint (${accountId}): ${error.message}`
      )
    })
  }
}

function getHeaderValueCaseInsensitive(headers, key) {
  if (!headers || typeof headers !== 'object') {
    return undefined
  }

  const lowerKey = key.toLowerCase()
  for (const candidate of Object.keys(headers)) {
    if (candidate.toLowerCase() === lowerKey) {
      return headers[candidate]
    }
  }

  return undefined
}

function headersChanged(original, updated) {
  if (original === updated) {
    return false
  }

  for (const key of STAINLESS_HEADER_KEYS) {
    if (
      getHeaderValueCaseInsensitive(original, key) !== getHeaderValueCaseInsensitive(updated, key)
    ) {
      return true
    }
  }

  return false
}

function normalizeBooleanFlag(value) {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return value !== 0
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return (
      normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on'
    )
  }
  return false
}

function normalizeRewriteMode(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')

  if (!normalized) {
    return DEFAULT_CLIENT_ID_REWRITE_MODE
  }

  const aliases = {
    off: 'preserve',
    none: 'preserve',
    disabled: 'preserve',
    preserve_original: 'preserve',
    legacy: 'legacy_global',
    global: 'legacy_global',
    unified_global: 'legacy_global',
    per_account: 'unified_per_account',
    account: 'unified_per_account',
    per_key: 'unified_per_api_key',
    per_api_key: 'unified_per_api_key',
    api_key: 'unified_per_api_key'
  }

  const resolved = aliases[normalized] || normalized
  return CLIENT_ID_REWRITE_MODES.has(resolved) ? resolved : DEFAULT_CLIENT_ID_REWRITE_MODE
}

function getClientIdRewriteMode() {
  return normalizeRewriteMode(
    process.env.CLIENT_ID_REWRITE_MODE || process.env.CLAUDE_CLIENT_ID_REWRITE_MODE
  )
}

function shouldGenerateClientIdWhenMissing() {
  const raw = process.env.CLIENT_ID_GENERATE_WHEN_MISSING
  if (raw === undefined || raw === '') {
    return true
  }
  return normalizeBooleanFlag(raw)
}

function isUnifiedClientIdEnabled(account) {
  if (!account || typeof account !== 'object') {
    return false
  }
  return normalizeBooleanFlag(account.useUnifiedClientId)
}

function normalizeDeviceId(candidate) {
  if (candidate === undefined || candidate === null) {
    return null
  }

  const trimmed = String(candidate).trim()
  if (!trimmed) {
    return null
  }

  if (/^[a-fA-F0-9]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }

  return hashHex(`metadata-device-id:${trimmed}`)
}

function resolveAccountId(payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const account = payload.account && typeof payload.account === 'object' ? payload.account : null
  const candidates = [
    payload.accountId,
    payload.account_id,
    payload.accountID,
    account && (account.accountId || account.account_id || account.accountID),
    account && (account.id || account.uuid),
    account && (account.account_uuid || account.accountUuid),
    account && (account.schedulerAccountId || account.scheduler_account_id)
  ]

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue
    }

    const stringified = String(candidate).trim()
    if (stringified) {
      return stringified
    }
  }

  return null
}

function resolveApiKeyScope(payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const apiKey =
    payload.apiKeyData && typeof payload.apiKeyData === 'object' ? payload.apiKeyData : null
  const requestOptions =
    payload.requestOptions && typeof payload.requestOptions === 'object'
      ? payload.requestOptions
      : null
  const requestApiKey =
    requestOptions && requestOptions.apiKeyData && typeof requestOptions.apiKeyData === 'object'
      ? requestOptions.apiKeyData
      : null

  const candidates = [
    payload.apiKeyId,
    payload.api_key_id,
    apiKey && (apiKey.id || apiKey.keyId || apiKey.key_id || apiKey.hash || apiKey.name),
    requestApiKey &&
      (requestApiKey.id ||
        requestApiKey.keyId ||
        requestApiKey.key_id ||
        requestApiKey.hash ||
        requestApiKey.name)
  ]

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue
    }
    const stringified = String(candidate).trim()
    if (stringified) {
      return hashHex(`api-key-scope:${stringified}`).slice(0, 32)
    }
  }

  return null
}

function resolveIdentityScope(accountId, payload, mode) {
  const accountScope = accountId ? String(accountId) : 'unknown-account'

  if (mode !== 'unified_per_api_key') {
    return accountScope
  }

  const apiKeyScope = resolveApiKeyScope(payload) || 'unknown-api-key'
  return `${accountScope}::api_key:${apiKeyScope}`
}

function resolveSessionScope(accountId, payload, mode) {
  const account = payload && typeof payload === 'object' ? payload.account : null
  if (isUnifiedClientIdEnabled(account) && mode === 'unified_per_api_key') {
    return resolveIdentityScope(accountId, payload, mode)
  }

  return accountId ? String(accountId) : 'unknown-scheduler'
}

function resolveUnifiedDeviceId(parsed, accountId, payload = {}) {
  const account = payload.account && typeof payload.account === 'object' ? payload.account : null
  const mode = getClientIdRewriteMode()

  if (!isUnifiedClientIdEnabled(account)) {
    return { deviceId: parsed.deviceId, mode: 'preserve_disabled', deviceChanged: false }
  }

  if (mode === 'preserve') {
    return { deviceId: parsed.deviceId, mode, deviceChanged: false }
  }

  const configuredDeviceId = normalizeDeviceId(account && account.unifiedClientId)

  if (mode === 'legacy_global') {
    const deviceId = configuredDeviceId || parsed.deviceId
    return { deviceId, mode, deviceChanged: deviceId !== parsed.deviceId }
  }

  if (!accountId && configuredDeviceId) {
    return {
      deviceId: configuredDeviceId,
      mode,
      deviceChanged: configuredDeviceId !== parsed.deviceId
    }
  }

  if (!accountId || (!configuredDeviceId && !shouldGenerateClientIdWhenMissing())) {
    return { deviceId: parsed.deviceId, mode, deviceChanged: false }
  }

  const identityScope = resolveIdentityScope(accountId, payload, mode)
  const baseDeviceId = configuredDeviceId || 'generated'
  const deviceId = hashHex(`client-id-rewrite:v1:${mode}:${identityScope}:${baseDeviceId}`)

  return { deviceId, mode, deviceChanged: deviceId !== parsed.deviceId }
}

function rewriteHeaders(headers, accountId, context = {}) {
  if (!headers || typeof headers !== 'object') {
    return { nextHeaders: headers, changed: false }
  }

  if (!accountId) {
    return { nextHeaders: { ...headers }, changed: false }
  }

  const workingHeaders = { ...headers }
  const fingerprint = collectFingerprintFromHeaders(workingHeaders)
  const fieldCount = Object.keys(fingerprint).length

  if (fieldCount < MIN_FINGERPRINT_FIELDS) {
    logger.warn(
      `requestIdentityService: account ${accountId} supplied insufficient Stainless fingerprint fields; keeping headers unchanged`
    )
    return { nextHeaders: workingHeaders, changed: false }
  }

  if (context.isRealClaudeCodeRequest === true) {
    try {
      persistFingerprint(accountId, fingerprint)
    } catch (error) {
      logger.error(
        `requestIdentityService: failed to persist fingerprint (${accountId}): ${error.message}`
      )
      return {
        abortResponse: {
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            error: 'fingerprint_persist_failed',
            message: 'Fingerprint persist failed'
          })
        }
      }
    }
  }

  const appliedHeaders = applyFingerprintToHeaders(workingHeaders, fingerprint)
  const changed = headersChanged(workingHeaders, appliedHeaders)

  return { nextHeaders: appliedHeaders, changed }
}

function normalizeAccountUuid(candidate) {
  if (typeof candidate !== 'string') {
    return null
  }

  const trimmed = candidate.trim()
  return trimmed || null
}

function extractAccountUuid(account) {
  if (!account || typeof account !== 'object') {
    return null
  }

  const directCandidates = [account.account_uuid, account.accountUuid]
  for (const candidate of directCandidates) {
    const normalized = normalizeAccountUuid(candidate)
    if (normalized) {
      return normalized
    }
  }

  const extInfoRaw = account.extInfo || account.ext_info
  if (!extInfoRaw) {
    return null
  }

  const extInfoObject =
    typeof extInfoRaw === 'string'
      ? safeParseJson(extInfoRaw)
      : extInfoRaw && typeof extInfoRaw === 'object'
        ? extInfoRaw
        : null

  if (!extInfoObject || typeof extInfoObject !== 'object') {
    return null
  }

  const extUuid = normalizeAccountUuid(extInfoObject.account_uuid || extInfoObject.accountUuid)
  return extUuid || null
}

function rewriteUserId(body, accountId, accountUuid, context = {}) {
  if (!body || typeof body !== 'object') {
    return { nextBody: body, changed: false }
  }

  const { metadata } = body
  if (!metadata || typeof metadata !== 'object') {
    return { nextBody: body, changed: false }
  }

  const userId = metadata.user_id
  if (typeof userId !== 'string') {
    return { nextBody: body, changed: false }
  }

  const parsed = metadataUserIdHelper.parse(userId)
  if (!parsed) {
    return { nextBody: body, changed: false }
  }

  const payloadContext = { ...context, accountId }
  const deviceResult = resolveUnifiedDeviceId(parsed, accountId, payloadContext)
  const seedTail = parsed.sessionId || 'default'
  const sessionScope = resolveSessionScope(accountId, payloadContext, deviceResult.mode)
  const hashedSession = formatUuidFromSeed(`${sessionScope}::${seedTail}`)
  const effectiveUuid = normalizeAccountUuid(accountUuid) || parsed.accountUuid || ''

  const nextUserId = metadataUserIdHelper.build({
    deviceId: deviceResult.deviceId,
    accountUuid: effectiveUuid,
    sessionId: hashedSession,
    isJsonFormat: parsed.isJsonFormat
  })

  const meta = {
    rewriteMode: deviceResult.mode,
    deviceChanged: deviceResult.deviceChanged,
    sessionChanged: hashedSession !== parsed.sessionId,
    accountUuidChanged: effectiveUuid !== parsed.accountUuid
  }

  if (nextUserId === userId) {
    return { nextBody: body, changed: false, meta }
  }

  return {
    nextBody: { ...body, metadata: { ...metadata, user_id: nextUserId } },
    changed: true,
    meta
  }
}

/**
 * Transform request identity data.
 * @param {Object} payload
 * @returns {Object} transformed { body, headers, abortResponse? }
 */
function transform(payload = {}) {
  const currentBody = payload.body
  const currentHeaders = payload.headers
  const accountId = resolveAccountId(payload)

  if (!accountId) {
    return {
      body: currentBody,
      headers: currentHeaders
    }
  }

  const context = { ...payload, accountId }
  const accountUuid = extractAccountUuid(payload.account)
  const userIdResult = rewriteUserId(currentBody, accountId, accountUuid, context)
  const headerResult = rewriteHeaders(currentHeaders, accountId, context)

  if (userIdResult.changed) {
    const meta = userIdResult.meta || {}
    logger.info('requestIdentityService: metadata.user_id normalized', {
      accountId,
      rewriteMode: meta.rewriteMode,
      deviceChanged: meta.deviceChanged === true,
      sessionChanged: meta.sessionChanged === true,
      accountUuidChanged: meta.accountUuidChanged === true,
      clientType: payload.isRealClaudeCodeRequest === true ? 'claude_code' : 'compatible'
    })
  }

  const nextHeaders = headerResult ? headerResult.nextHeaders : currentHeaders
  const abortResponse =
    headerResult && headerResult.abortResponse ? headerResult.abortResponse : null

  return {
    body: userIdResult.nextBody,
    headers: nextHeaders,
    abortResponse
  }
}

module.exports = {
  transform,
  _internal: {
    formatUuidFromSeed,
    collectFingerprintFromHeaders,
    rewriteHeaders,
    rewriteUserId,
    extractAccountUuid,
    resolveAccountId,
    resolveApiKeyScope,
    resolveUnifiedDeviceId,
    getClientIdRewriteMode,
    normalizeRewriteMode,
    isUnifiedClientIdEnabled,
    normalizeDeviceId
  }
}
