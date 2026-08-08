/**
 * Codex 额度展示辅助函数。
 *
 * 上游的 primary / secondary 只是槽位，真实含义由 windowMinutes 决定：周限完全可能单独出现在
 * primary。所以标签一律按窗口长度推导，绝不按槽位名写死。
 */

// 官方窗口长度与展示标签的对照
const KNOWN_WINDOWS = [
  { minutes: 300, label: '5h' },
  { minutes: 1440, label: '日限' },
  { minutes: 10080, label: '周限' },
  { minutes: 43200, label: '月限' },
  { minutes: 525600, label: '年限' }
]

// 上游窗口长度存在小幅波动，用相对容差就近匹配
const WINDOW_MATCH_TOLERANCE = 0.1

const AVAILABILITY_LABELS = {
  quota_exhausted: '额度已用尽',
  server_overloaded: '模型容量暂时不足',
  model_not_available: '模型不可用',
  client_identity_rejected: '客户端身份被拒绝',
  unknown_upstream_error: '上游异常'
}

const AVAILABILITY_CLASSES = {
  quota_exhausted: 'bg-red-100 text-red-600 dark:bg-red-500/20 dark:text-red-300',
  server_overloaded: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  model_not_available: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
  client_identity_rejected:
    'bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300',
  unknown_upstream_error: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
}

function toNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * 按窗口长度生成展示标签。这是修掉「周限被标成 5h」的核心。
 */
export function formatCodexWindowLabel(windowMinutes) {
  const minutes = toNumberOrNull(windowMinutes)
  if (minutes === null || minutes <= 0) {
    // 上游没给窗口长度时不能猜，用中性文案而不是默认 5h
    return '限额'
  }

  for (const known of KNOWN_WINDOWS) {
    if (Math.abs(minutes - known.minutes) <= known.minutes * WINDOW_MATCH_TOLERANCE) {
      return known.label
    }
  }

  if (minutes < 60) return `${Math.round(minutes)}分钟`
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}天`
}

/**
 * 归一化已使用百分比。窗口已过重置点时视为 0：那个窗口确实已经空了。
 */
export function normalizeCodexUsagePercent(window) {
  if (!window) return null

  const percent = toNumberOrNull(window.usedPercent)
  const resetAtMs = window.resetAt ? Date.parse(window.resetAt) : null

  if (resetAtMs !== null && !Number.isNaN(resetAtMs) && Date.now() >= resetAtMs) {
    return 0
  }

  if (percent === null) return null
  return Math.max(0, Math.min(100, percent))
}

export function formatCodexUsagePercent(window) {
  const percent = normalizeCodexUsagePercent(window)
  if (percent === null) return '--'
  return `${percent.toFixed(1)}%`
}

export function formatCodexRemainingPercent(window) {
  const percent = normalizeCodexUsagePercent(window)
  if (percent === null) return '--'
  return `${(100 - percent).toFixed(1)}%`
}

export function getCodexUsageWidth(window) {
  const percent = normalizeCodexUsagePercent(window)
  if (percent === null) return '0%'
  return `${percent}%`
}

export function getCodexUsageBarClass(window) {
  const percent = normalizeCodexUsagePercent(window)
  if (percent === null) return 'bg-gradient-to-r from-gray-300 to-gray-400'
  if (percent >= 90) return 'bg-gradient-to-r from-red-500 to-red-600'
  if (percent >= 75) return 'bg-gradient-to-r from-yellow-500 to-orange-500'
  return 'bg-gradient-to-r from-emerald-500 to-teal-500'
}

/**
 * 倒计时。以绝对 resetAt 为准，实时算；没有绝对时间时才回落到服务端算好的秒数。
 */
export function formatCodexRemaining(window) {
  if (!window) return '--'

  let seconds = null

  const resetAtMs = window.resetAt ? Date.parse(window.resetAt) : null
  if (resetAtMs !== null && !Number.isNaN(resetAtMs)) {
    seconds = Math.max(0, Math.floor((resetAtMs - Date.now()) / 1000))
  } else {
    seconds = toNumberOrNull(window.remainingSeconds)
  }

  if (seconds === null) return '--'

  seconds = Math.max(0, Math.floor(seconds))

  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`
  if (minutes > 0) return `${minutes}分钟`
  return `${secs}秒`
}

/**
 * 绝对重置时间，作为倒计时的辅助信息。
 */
export function formatCodexResetDate(window) {
  if (!window?.resetAt) return ''
  const ms = Date.parse(window.resetAt)
  if (Number.isNaN(ms)) return ''

  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 把 limits[] 摊平成可渲染的行，只产出真实存在的窗口。
 * 上游不再返回的窗口不会出现在这里，也就不会再有幽灵卡片。
 */
export function flattenCodexLimits(codexUsage) {
  if (!codexUsage || !Array.isArray(codexUsage.limits)) return []

  const rows = []

  for (const limit of codexUsage.limits) {
    if (!limit) continue

    const isAdditional = limit.limitId !== 'codex'

    for (const slot of ['primary', 'secondary']) {
      const window = limit[slot]
      if (!window) continue

      const label = formatCodexWindowLabel(window.windowMinutes)
      const prefix = isAdditional ? limit.limitName || limit.limitId : ''

      rows.push({
        key: `${limit.limitId}:${slot}`,
        limitId: limit.limitId,
        limitName: limit.limitName || null,
        slot,
        label,
        title: prefix ? `${prefix} - ${label}` : label,
        isAdditional,
        window
      })
    }
  }

  return rows
}

export function hasAnyCodexUsage(codexUsage) {
  return flattenCodexLimits(codexUsage).length > 0
}

export function isCodexSnapshotStale(codexUsage) {
  return Boolean(codexUsage?.isStale)
}

/**
 * 上游可用性状态。容量不足与额度耗尽是两回事，必须分开展示。
 */
export function getCodexAvailabilityBadges(codexAvailability) {
  if (!codexAvailability) return []

  const badges = []

  const push = (scope, entry) => {
    if (!entry?.state || entry.state === 'ok') return
    const label = AVAILABILITY_LABELS[entry.state]
    if (!label) return
    badges.push({
      key: `${scope}:${entry.state}`,
      scope,
      state: entry.state,
      text: scope === 'account' ? label : `${scope}：${label}`,
      detail: entry.detail || '',
      className: AVAILABILITY_CLASSES[entry.state] || AVAILABILITY_CLASSES.unknown_upstream_error
    })
  }

  push('account', codexAvailability.account)

  for (const [model, entry] of Object.entries(codexAvailability.models || {})) {
    push(model, entry)
  }

  return badges
}
