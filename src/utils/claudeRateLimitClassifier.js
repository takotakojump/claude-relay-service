/**
 * Claude 上游 429 限流分类器（纯函数，无副作用、无 IO）
 *
 * 目标：把原本散落在 relay 三处（非流式 / 流式早期 / 流式 usage capture）的 429 判定逻辑
 * 收敛到一个统一入口，便于单测与复盘。
 *
 * v1 范围（观测先行）：
 *  - 判定动作只由 `anthropic-ratelimit-unified-reset`（Unix 秒）+ retry-after 驱动，保持现有行为。
 *  - 新增 quota header（representative-claim / 5h-reset / 7d-reset / overage-*）只解析进 `observed`
 *    供日志记录，不参与判定。等抓到真实样本后再决定是否升级为强制判定。
 */

const HEADERS = {
  unifiedReset: 'anthropic-ratelimit-unified-reset',
  representativeClaim: 'anthropic-ratelimit-unified-representative-claim',
  unifiedStatus: 'anthropic-ratelimit-unified-status',
  overageStatus: 'anthropic-ratelimit-unified-overage-status',
  fiveHourReset: 'anthropic-ratelimit-unified-5h-reset',
  sevenDayReset: 'anthropic-ratelimit-unified-7d-reset',
  overageReset: 'anthropic-ratelimit-unified-overage-reset'
}

// 大小写不敏感读取响应头（Node 通常已小写，但 relay 历史代码存在混合大小写写法）
const getHeader = (headers, name) => {
  if (!headers || typeof headers !== 'object') {
    return null
  }
  const lower = name.toLowerCase()
  if (headers[lower] !== undefined && headers[lower] !== null) {
    return headers[lower]
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      return headers[key]
    }
  }
  return null
}

// 解析 unified-reset（Unix 秒），沿用 relay 现有口径：parseInt 后必须为有限正数
const parseUnixSeconds = (value) => {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null
  }
  return parsed
}

// 解析 retry-after（秒数或 HTTP 日期），与 upstreamErrorHelper.parseRetryAfter 的 retry-after 分支口径一致
const parseRetryAfterSeconds = (headers) => {
  const retryAfter = getHeader(headers, 'retry-after')
  if (!retryAfter) {
    return null
  }
  const seconds = parseInt(retryAfter, 10)
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds
  }
  const date = new Date(retryAfter)
  if (!Number.isNaN(date.getTime())) {
    const diff = Math.ceil((date.getTime() - Date.now()) / 1000)
    if (diff > 0) {
      return diff
    }
  }
  return null
}

/**
 * 分类 Claude 上游 429
 * @param {Object} params
 * @param {number} params.statusCode - HTTP 状态码
 * @param {Object} params.headers - 响应头
 * @param {boolean} [params.isOpusModelRequest=false] - 请求模型是否为 Opus
 * @param {boolean} [params.isExtraUsage=false] - 是否为 "Extra usage required" 类 429（由调用方判定后传入）
 * @returns {{kind:string, action:string, resetTimestamp:(number|null), retryAfterSeconds:(number|null), hasQuotaHeaders:boolean, observed:Object}}
 */
const classifyClaude429 = ({
  statusCode,
  headers,
  isOpusModelRequest = false,
  isExtraUsage = false
} = {}) => {
  const representativeClaim = getHeader(headers, HEADERS.representativeClaim)
  const unifiedStatus = getHeader(headers, HEADERS.unifiedStatus)
  const overageStatus = getHeader(headers, HEADERS.overageStatus)
  const fiveHourReset = getHeader(headers, HEADERS.fiveHourReset)
  const sevenDayReset = getHeader(headers, HEADERS.sevenDayReset)
  const overageReset = getHeader(headers, HEADERS.overageReset)

  const resetTimestamp = parseUnixSeconds(getHeader(headers, HEADERS.unifiedReset))
  const retryAfterSeconds = parseRetryAfterSeconds(headers)

  // resetSource 仅用于日志：标记真正解析出 reset 的来源
  let resetSource = null
  if (resetTimestamp) {
    resetSource = 'unified-reset'
  } else if (fiveHourReset) {
    resetSource = '5h-reset'
  } else if (sevenDayReset) {
    resetSource = '7d-reset'
  } else if (overageReset) {
    resetSource = 'overage-reset'
  }

  const hasQuotaHeaders = Boolean(
    representativeClaim ||
      unifiedStatus ||
      overageStatus ||
      fiveHourReset ||
      sevenDayReset ||
      overageReset ||
      resetTimestamp
  )

  const observed = {
    representativeClaim: representativeClaim || null,
    unifiedStatus: unifiedStatus || null,
    overageStatus: overageStatus || null,
    fiveHourReset: fiveHourReset || null,
    sevenDayReset: sevenDayReset || null,
    overageReset: overageReset || null,
    resetSource
  }

  const base = { resetTimestamp, retryAfterSeconds, hasQuotaHeaders, observed }

  if (statusCode !== 429) {
    return { kind: 'non_rate_limit_429', action: 'skip', ...base }
  }

  if (isExtraUsage) {
    return { kind: 'extra_usage_required', action: 'skip', ...base }
  }

  // v1：仅 unified-reset 驱动判定，保持现有行为
  if (resetTimestamp) {
    if (isOpusModelRequest) {
      return { kind: 'opus_rate_limit', action: 'opus_rate_limit', ...base }
    }
    return { kind: 'quota_limit', action: 'hard_rate_limit', ...base }
  }

  // 无 reset：headerless 429 → 短冷却（A1 止血核心）
  return { kind: 'headerless_429', action: 'short_cooldown', ...base }
}

/**
 * 计算 headerless 429 的阶梯冷却时长（纯函数）
 * = min(baseSeconds * factor^(count-1), maxSeconds)
 * @param {number} consecutiveCount - 连续 headerless 次数（从 1 开始）
 * @param {{baseSeconds:number, factor:number, maxSeconds:number}} tiers
 * @returns {number} 冷却秒数
 */
const computeHeaderlessCooldownSeconds = (consecutiveCount, tiers = {}) => {
  const baseSeconds =
    Number.isFinite(tiers.baseSeconds) && tiers.baseSeconds > 0 ? tiers.baseSeconds : 300
  const factor = Number.isFinite(tiers.factor) && tiers.factor >= 1 ? tiers.factor : 3
  const maxSeconds =
    Number.isFinite(tiers.maxSeconds) && tiers.maxSeconds > 0 ? tiers.maxSeconds : 14400

  const count = Number.isFinite(consecutiveCount) && consecutiveCount >= 1 ? consecutiveCount : 1
  const escalated = baseSeconds * factor ** (count - 1)
  return Math.floor(Math.min(escalated, maxSeconds))
}

module.exports = {
  classifyClaude429,
  computeHeaderlessCooldownSeconds,
  getHeader,
  HEADERS
}
