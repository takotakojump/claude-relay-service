/**
 * Classify a Codex upstream failure for the quota panel.
 *
 * The distinction that matters: "Selected model is at capacity" is a capacity problem, not an
 * exhausted quota. The official client files it under ServerOverloaded, and drawing it as 100%
 * usage is what makes a temporary capacity blip look like a burned weekly allowance.
 *
 * Separate from upstreamErrorHelper.classifyError, which maps HTTP status codes to account cooldown
 * policy. This one decides what the user is told about availability.
 */

const CODEX_AVAILABILITY_STATES = {
  OK: 'ok',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  SERVER_OVERLOADED: 'server_overloaded',
  MODEL_NOT_AVAILABLE: 'model_not_available',
  CLIENT_IDENTITY_REJECTED: 'client_identity_rejected',
  UNKNOWN_UPSTREAM_ERROR: 'unknown_upstream_error'
}

const MAX_DETAIL_LENGTH = 300

const CAPACITY_PATTERN = /at capacity|server[_\s-]?overloaded|overloaded|capacity_exceeded/i
const QUOTA_PATTERN = /usage[_\s-]?limit|rate[_\s-]?limit|quota|insufficient_quota/i
const MODEL_UNAVAILABLE_PATTERN =
  /model[_\s-]?not[_\s-]?found|does not exist|do not have access|not available|unsupported[_\s-]?model|invalid[_\s-]?model/i
const CLIENT_IDENTITY_PATTERN =
  /originator|user[_\s-]?agent|client[_\s-]?version|unsupported[_\s-]?client|upgrade[_\s-]?required|please update/i

function truncate(value) {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > MAX_DETAIL_LENGTH ? `${trimmed.slice(0, MAX_DETAIL_LENGTH)}…` : trimmed
}

// Error bodies arrive as objects, JSON strings, or raw text depending on stream mode and upstream.
function extractErrorText(errorBody) {
  if (!errorBody) {
    return { message: null, type: null }
  }

  if (typeof errorBody === 'string') {
    try {
      return extractErrorText(JSON.parse(errorBody))
    } catch (error) {
      return { message: truncate(errorBody), type: null }
    }
  }

  if (typeof errorBody !== 'object') {
    return { message: null, type: null }
  }

  const error = typeof errorBody.error === 'object' && errorBody.error ? errorBody.error : errorBody

  const message = truncate(error.message || error.detail || errorBody.message || errorBody.detail)
  const type = truncate(error.type || error.code || errorBody.type || errorBody.code)

  return { message, type }
}

/**
 * @param {number|null} statusCode  upstream HTTP status
 * @param {*}           errorBody   parsed body, JSON string, or raw text
 * @param {object}      _headers    upstream response headers (reserved for future signals)
 * @returns {{state: string, detail: string|null}}
 */
function classifyCodexUpstreamError(statusCode, errorBody, _headers = {}) {
  const status = Number(statusCode)
  const { message, type } = extractErrorText(errorBody)
  const haystack = [message, type].filter(Boolean).join(' ')

  const detail = message || type || null

  if (Number.isFinite(status) && status >= 200 && status < 300) {
    return { state: CODEX_AVAILABILITY_STATES.OK, detail: null }
  }

  // Checked before the quota rules on purpose: upstream sometimes returns capacity errors on 429,
  // and treating those as exhausted quota is the exact misreport this exists to prevent.
  if (CAPACITY_PATTERN.test(haystack)) {
    return { state: CODEX_AVAILABILITY_STATES.SERVER_OVERLOADED, detail }
  }

  if (CLIENT_IDENTITY_PATTERN.test(haystack) || status === 426) {
    return { state: CODEX_AVAILABILITY_STATES.CLIENT_IDENTITY_REJECTED, detail }
  }

  if (MODEL_UNAVAILABLE_PATTERN.test(haystack)) {
    return { state: CODEX_AVAILABILITY_STATES.MODEL_NOT_AVAILABLE, detail }
  }

  if (status === 429 || QUOTA_PATTERN.test(haystack)) {
    return { state: CODEX_AVAILABILITY_STATES.QUOTA_EXHAUSTED, detail }
  }

  if (status === 404) {
    return { state: CODEX_AVAILABILITY_STATES.MODEL_NOT_AVAILABLE, detail }
  }

  return { state: CODEX_AVAILABILITY_STATES.UNKNOWN_UPSTREAM_ERROR, detail }
}

// Convenience guard for call sites that must not mark an account rate limited on capacity errors.
function isQuotaExhausted(state) {
  return state === CODEX_AVAILABILITY_STATES.QUOTA_EXHAUSTED
}

module.exports = {
  classifyCodexUpstreamError,
  isQuotaExhausted,
  CODEX_AVAILABILITY_STATES
}
