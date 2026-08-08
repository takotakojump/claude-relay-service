/**
 * Codex rate limit header parsing.
 *
 * Upstream reports quota through `x-{limitId}-{slot}-*` response headers. The default Codex bucket
 * uses `x-codex-*`, but additional per-model buckets (Sol, Terra, ...) arrive under their own
 * prefixes. We therefore discover limit ids by scanning for the `-used-percent` headers instead of
 * hardcoding `x-codex-*`, mirroring the official client.
 *
 * `primary` / `secondary` are only slots. Their meaning (5h, weekly, monthly, ...) is carried by
 * `window-minutes` and must never be inferred from the slot name.
 */

const WINDOW_SLOTS = ['primary', 'secondary']

// Values below this are treated as epoch seconds; above it, epoch milliseconds.
// 1e12 ms is 2001-09-09, so any plausible epoch-seconds value stays under it.
const EPOCH_MS_THRESHOLD = 1e12

function normalizeHeaders(headers = {}) {
  if (!headers || typeof headers !== 'object') {
    return {}
  }

  const normalized = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!key) {
      continue
    }
    normalized[key.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return normalized
}

function toNumberSafe(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }

  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

// Normalize a header-derived limit id into a stable key. Separators vary (`codex-sol` vs
// `codex_sol`) depending on the proxy, so collapse everything to underscores.
function normalizeLimitId(rawId) {
  if (!rawId || typeof rawId !== 'string') {
    return null
  }

  const normalized = rawId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return normalized || null
}

/**
 * Resolve an absolute reset timestamp.
 *
 * `reset-at` is authoritative. `reset-after-seconds` is the legacy relative form and is converted
 * to absolute time immediately on receipt — storing it relative is what makes reset times drift
 * forward every time an unrelated window is refreshed.
 */
function resolveResetAt(absoluteRaw, relativeSecondsRaw, nowMs) {
  if (absoluteRaw !== undefined && absoluteRaw !== null && absoluteRaw !== '') {
    const numeric = Number(absoluteRaw)
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric < EPOCH_MS_THRESHOLD ? numeric * 1000 : numeric
      return new Date(ms).toISOString()
    }

    const parsed = Date.parse(absoluteRaw)
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString()
    }
  }

  const relativeSeconds = toNumberSafe(relativeSecondsRaw)
  if (relativeSeconds !== null && relativeSeconds >= 0) {
    return new Date(nowMs + relativeSeconds * 1000).toISOString()
  }

  return null
}

function parseWindow(normalized, rawId, slot, nowMs) {
  const usedPercent = toNumberSafe(normalized[`x-${rawId}-${slot}-used-percent`])
  const windowMinutes = toNumberSafe(normalized[`x-${rawId}-${slot}-window-minutes`])
  const resetAt = resolveResetAt(
    normalized[`x-${rawId}-${slot}-reset-at`],
    normalized[`x-${rawId}-${slot}-reset-after-seconds`],
    nowMs
  )

  if (usedPercent === null && windowMinutes === null && resetAt === null) {
    return null
  }

  return { usedPercent, windowMinutes, resetAt }
}

// Compiled once. This runs against every header of every Codex response, so building the patterns
// inside the scan loop would recompile them dozens of times per request.
const LIMIT_ID_PATTERNS = WINDOW_SLOTS.map((slot) => new RegExp(`^x-(.+?)-${slot}-used-percent$`))

// Discover the raw limit id prefixes present in this response, e.g. `codex`, `codex-sol`.
function collectRawLimitIds(normalized) {
  const rawIds = []

  for (const key of Object.keys(normalized)) {
    for (const pattern of LIMIT_ID_PATTERNS) {
      const match = key.match(pattern)
      if (match && !rawIds.includes(match[1])) {
        rawIds.push(match[1])
      }
    }
  }

  return rawIds
}

/**
 * Parse Codex quota headers into the canonical snapshot shape.
 *
 * Returns null when the response carries no quota headers at all — callers must treat that as
 * "no information" and leave stored data untouched, not as "all windows disappeared".
 */
function parseCodexRateLimitHeaders(headers, { now = Date.now() } = {}) {
  const normalized = normalizeHeaders(headers)
  if (Object.keys(normalized).length === 0) {
    return null
  }

  const capturedAt = new Date(now).toISOString()
  const limits = []

  for (const rawId of collectRawLimitIds(normalized)) {
    const limitId = normalizeLimitId(rawId)
    if (!limitId) {
      continue
    }

    const primary = parseWindow(normalized, rawId, 'primary', now)
    const secondary = parseWindow(normalized, rawId, 'secondary', now)
    if (!primary && !secondary) {
      continue
    }

    const limitName = normalized[`x-${rawId}-limit-name`] || null
    const primaryOverSecondaryPercent = toNumberSafe(
      normalized[`x-${rawId}-primary-over-secondary-limit-percent`]
    )

    limits.push({
      limitId,
      limitName,
      meteredFeature: null,
      capturedAt,
      primary,
      secondary,
      primaryOverSecondaryPercent
    })
  }

  if (limits.length === 0) {
    return null
  }

  return { capturedAt, limits }
}

module.exports = {
  parseCodexRateLimitHeaders,
  normalizeHeaders,
  normalizeLimitId,
  resolveResetAt,
  toNumberSafe,
  WINDOW_SLOTS
}
