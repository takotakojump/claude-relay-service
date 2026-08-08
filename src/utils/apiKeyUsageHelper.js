/**
 * Read-only usage lookups for an API key.
 *
 * Everything here reads Redis and nothing else — no upstream calls, no counters incremented. The
 * service-window read in particular must never go through redis.checkAndIncrementServiceWindow,
 * which bumps the request counter: querying your own usage would then consume quota.
 */

const redis = require('../models/redis')

function toPositiveNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : 0
}

/**
 * Current state of the key-level rate limit window.
 *
 * Mirrors the enforcement layer's view: once the window has elapsed the counters are reported as
 * zero, because the next request will start a fresh window.
 */
async function getKeyRateLimitWindowUsage(keyId, rateLimitWindowMinutes) {
  const windowMinutes = toPositiveNumber(rateLimitWindowMinutes)

  const result = {
    windowMinutes,
    requests: 0,
    tokens: 0,
    cost: 0,
    startAt: null,
    endAt: null,
    remainingSeconds: null
  }

  if (windowMinutes <= 0) {
    return result
  }

  const client = redis.getClientSafe()
  const [requestsRaw, tokensRaw, costRaw, windowStartRaw] = await Promise.all([
    client.get(`rate_limit:requests:${keyId}`),
    client.get(`rate_limit:tokens:${keyId}`),
    client.get(`rate_limit:cost:${keyId}`),
    client.get(`rate_limit:window_start:${keyId}`)
  ])

  result.requests = parseInt(requestsRaw || '0', 10) || 0
  result.tokens = parseInt(tokensRaw || '0', 10) || 0
  result.cost = parseFloat(costRaw || '0') || 0

  if (!windowStartRaw) {
    return result
  }

  const startAt = parseInt(windowStartRaw, 10)
  const endAt = startAt + windowMinutes * 60 * 1000
  const now = Date.now()

  if (now < endAt) {
    result.startAt = startAt
    result.endAt = endAt
    result.remainingSeconds = Math.max(0, Math.floor((endAt - now) / 1000))
    return result
  }

  // 窗口已过期：下次请求会重置，所以当前用量按 0 呈现
  result.remainingSeconds = 0
  result.requests = 0
  result.tokens = 0
  result.cost = 0
  return result
}

/**
 * Per-service (model family) limits configured on the key, each with its current usage.
 *
 * Only services that actually have limits configured are reported — there is no meaningful
 * "current usage" bucket for a service the key never constrained.
 */
async function getServiceLimitsUsage(keyId, keyData) {
  const serviceLimits =
    keyData?.serviceLimits && typeof keyData.serviceLimits === 'object' ? keyData.serviceLimits : {}

  const entries = Object.entries(serviceLimits)
  if (entries.length === 0) {
    return []
  }

  const resetDay = parseInt(keyData.weeklyResetDay || 1, 10) || 1
  const resetHour = parseInt(keyData.weeklyResetHour || 0, 10) || 0

  return Promise.all(
    entries.map(async ([service, limits]) => {
      const dailyCostLimit = toPositiveNumber(limits?.dailyCostLimit)
      const weeklyCostLimit = toPositiveNumber(limits?.weeklyCostLimit)
      const windowMinutes = toPositiveNumber(limits?.windowMinutes)
      const windowRequests = toPositiveNumber(limits?.windowRequests)
      const windowCost = toPositiveNumber(limits?.windowCost)

      const [currentDailyCost, currentWeeklyCost, window] = await Promise.all([
        redis.getServiceDailyCost(keyId, service),
        redis.getServiceWeeklyCost(keyId, service, resetDay, resetHour),
        windowMinutes > 0
          ? redis.peekServiceWindow(keyId, service, windowMinutes)
          : Promise.resolve(null)
      ])

      const currentWindowRequests = window?.currentRequests || 0
      const currentWindowCost = window?.currentCost || 0

      const exceeded =
        (dailyCostLimit > 0 && currentDailyCost >= dailyCostLimit) ||
        (weeklyCostLimit > 0 && currentWeeklyCost >= weeklyCostLimit) ||
        (windowRequests > 0 && currentWindowRequests >= windowRequests) ||
        (windowCost > 0 && currentWindowCost >= windowCost)

      return {
        service,
        dailyCostLimit,
        currentDailyCost,
        dailyResetAt: redis.getNextDailyResetTime().toISOString(),
        weeklyCostLimit,
        currentWeeklyCost,
        weeklyResetAt: redis.getNextResetTime(resetDay, resetHour).toISOString(),
        windowMinutes,
        windowRequests,
        currentWindowRequests,
        windowCost,
        currentWindowCost,
        windowResetAt: window?.resetAt || null,
        exceeded
      }
    })
  )
}

module.exports = {
  getKeyRateLimitWindowUsage,
  getServiceLimitsUsage,
  toPositiveNumber
}
