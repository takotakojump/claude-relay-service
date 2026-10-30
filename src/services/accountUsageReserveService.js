const redis = require('../models/redis')
const claudeRelayConfigService = require('./claudeRelayConfigService')
const ccrAccountService = require('./account/ccrAccountService')
const { getUsageWindows } = require('../utils/accountUsageReserve')

const windowId = ({ window, resetAt }) => `${window}:${resetAt}`
const stateVersion = (windows, resetAt) =>
  windows.length ? JSON.stringify([windows.map(windowId).sort(), resetAt]) : null
const activeWindows = (windows, now) =>
  windows.filter((item) => item && Date.parse(item.resetAt) > now)

const readSavedWindows = (raw, current) => {
  if (!raw) {
    return []
  }
  try {
    const saved = JSON.parse(raw)
    if (Array.isArray(saved?.windows)) {
      return saved.windows
    }
  } catch (_) {
    // Previous releases stored only the latest reset time.
  }
  const resetAt = new Date(raw).toISOString()
  return current.filter((item) => item.resetAt === resetAt).length
    ? current.filter((item) => item.resetAt === resetAt)
    : [{ window: 'unknown', resetAt }]
}

const getState = async (account, accountType, now = Date.now()) => {
  const empty = {
    autoPaused: false,
    paused: false,
    temporaryScheduling: false,
    windows: [],
    version: null
  }
  if (!account || !['claude-official', 'ccr'].includes(accountType)) {
    return empty
  }

  const { accountUsageReservePercent } = await claudeRelayConfigService.getConfig()
  if (!accountUsageReservePercent) {
    return empty
  }

  const client = redis.getClientSafe()
  const pauseKey = `usage_reserve_pause:${accountType}:${account.id}`
  const overrideKey = `usage_reserve_override:${accountType}:${account.id}`
  let snapshotAccount = account
  if (accountType === 'ccr' && !account.sessionWindow) {
    snapshotAccount = {
      ...account,
      sessionWindow: await ccrAccountService.getSessionWindowSnapshot(account.id)
    }
  } else if (
    accountType === 'claude-official' &&
    !Object.hasOwn(account, 'claudeFiveHourUtilization') &&
    !Object.hasOwn(account, 'claudeRateLimitWindows')
  ) {
    snapshotAccount = (await redis.getClaudeAccount(account.id)) || account
  }
  const observed = getUsageWindows(snapshotAccount, accountType, now)
  const current = observed.filter(
    (item) => 100 - item.utilization <= Number(accountUsageReservePercent)
  )
  let [savedRaw, overrideRaw] = await Promise.all([client.get(pauseKey), client.get(overrideKey)])
  if (savedRaw) {
    try {
      const savedMarker = JSON.parse(savedRaw)
      if (
        Array.isArray(savedMarker?.windows) &&
        savedMarker.threshold !== undefined &&
        Number(savedMarker.threshold) !== Number(accountUsageReservePercent)
      ) {
        await Promise.all([client.del(pauseKey), client.del(overrideKey)])
        savedRaw = null
        overrideRaw = null
      }
    } catch (_) {
      // Keep the legacy reset-time marker until it expires.
    }
  }
  let saved = []
  if (savedRaw) {
    try {
      saved = activeWindows(readSavedWindows(savedRaw, current), now)
    } catch (_) {
      // Ignore an invalid or expired legacy pause marker.
    }
  }

  const byId = new Map()
  for (const item of [...saved, ...current]) {
    byId.set(windowId(item), item)
  }
  const windows = [...byId.values()].sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt))
  const nearestResetAt =
    [...windows, ...observed].sort((a, b) => Date.parse(a.resetAt) - Date.parse(b.resetAt))[0]
      ?.resetAt || null
  const previousIds = saved.map(windowId).sort().join('|')
  const currentIds = windows.map(windowId).sort().join('|')
  if (windows.length && (!savedRaw || previousIds !== currentIds)) {
    const latestReset = Date.parse(windows[windows.length - 1].resetAt)
    await client.set(
      pauseKey,
      JSON.stringify({ threshold: accountUsageReservePercent, windows }),
      'EX',
      Math.max(1, Math.ceil((latestReset - now) / 1000))
    )
  }

  let override = null
  if (overrideRaw) {
    try {
      override = JSON.parse(overrideRaw)
    } catch (_) {
      // Invalid override data cannot enable scheduling.
    }
  }
  const temporaryScheduling = Boolean(
    windows.length &&
      override &&
      Date.parse(override.expiresAt) > now &&
      Array.isArray(override.windowIds) &&
      windows.every((item) => override.windowIds.includes(windowId(item)))
  )
  if (override && windows.length && !temporaryScheduling) {
    await client.del(overrideKey)
  }

  return {
    autoPaused: windows.length > 0,
    paused: windows.length > 0 && !temporaryScheduling,
    temporaryScheduling,
    windows,
    version: stateVersion(windows, nearestResetAt),
    resetAt: nearestResetAt,
    temporaryExpiresAt: temporaryScheduling ? override.expiresAt : null
  }
}

const setTemporaryScheduling = async (account, accountType, enabled, expectedVersion) => {
  const state = await getState(account, accountType)
  const client = redis.getClientSafe()
  const key = `usage_reserve_override:${accountType}:${account.id}`
  if (!enabled) {
    await client.del(key)
    return getState(account, accountType)
  }
  if (!state.autoPaused || state.version !== expectedVersion) {
    const error = new Error('用量窗口已变化，请确认最新状态后重试')
    error.code = 'USAGE_RESERVE_STATE_CHANGED'
    error.state = state
    throw error
  }
  if (state.temporaryScheduling) {
    return state
  }
  const expiresAt = state.resetAt
  await client.set(
    key,
    JSON.stringify({ expiresAt, windowIds: state.windows.map(windowId) }),
    'EX',
    Math.max(1, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000))
  )
  return getState(account, accountType)
}

module.exports = { getState, setTemporaryScheduling }
