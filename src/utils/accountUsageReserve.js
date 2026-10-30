const parseReset = (value) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const numeric = Number(value)
  const timestamp =
    Number.isFinite(numeric) && numeric > 0
      ? numeric < 1e12
        ? numeric * 1000
        : numeric
      : Date.parse(value)
  return Number.isFinite(timestamp) && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null
}

const parseUtilization = (value, isRatio = false) => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    return null
  }
  return isRatio && numeric <= 1 ? numeric * 100 : numeric
}

const getUsageWindows = (account, accountType, now = Date.now()) => {
  if (!account) {
    return []
  }

  let windows = []
  if (accountType === 'claude-official') {
    windows = [
      ['5h', account.claudeFiveHourUtilization, account.claudeFiveHourResetsAt],
      ['7d', account.claudeSevenDayUtilization, account.claudeSevenDayResetsAt],
      ['7d_sonnet', account.claudeSevenDayOpusUtilization, account.claudeSevenDayOpusResetsAt]
    ]
    try {
      const headerSnapshot = JSON.parse(account.claudeRateLimitWindows || 'null')
      const usageTime = parseReset(account.claudeUsageUpdatedAt)
      if (Array.isArray(headerSnapshot?.windows)) {
        for (const window of headerSnapshot.windows) {
          if (!window || !['5h', '7d', '7d_oi'].includes(window.key)) {
            continue
          }
          const headerTime = parseReset(window.observedAt || headerSnapshot.observedAt)
          if (window.key === '7d_oi') {
            windows.push([window.key, parseUtilization(window.utilization, true), window.reset])
          } else if (headerTime && (!usageTime || headerTime >= usageTime)) {
            const index = window.key === '5h' ? 0 : 1
            windows[index] = [window.key, parseUtilization(window.utilization, true), window.reset]
          }
        }
      }
    } catch (_) {
      // The OAuth usage snapshot remains usable when the header snapshot is malformed.
    }
    try {
      const scoped = JSON.parse(account.claudeWeeklyScopedModels || '[]')
      if (Array.isArray(scoped)) {
        windows.push(
          ...scoped
            .filter((item) => item?.isActive === true)
            .map((item) => [item.modelName || 'weekly_scoped', item.utilization, item.resetsAt])
        )
      }
    } catch (_) {
      // Invalid optional scoped data must not prevent regular window checks.
    }
  } else if (accountType === 'ccr') {
    try {
      const snapshot =
        typeof account.sessionWindow === 'string'
          ? JSON.parse(account.sessionWindow)
          : account.sessionWindow
      if (Array.isArray(snapshot?.windows)) {
        windows = snapshot.windows.map((window) => [
          window?.key,
          window?.utilization,
          window?.reset
        ])
      }
    } catch (_) {
      return []
    }
  } else {
    return []
  }

  const activeWindows = []
  for (const [key, rawUtilization, rawReset] of windows) {
    const utilization = parseUtilization(rawUtilization, accountType === 'ccr')
    const resetAt = parseReset(rawReset)
    if (utilization !== null && resetAt !== null && resetAt > now) {
      activeWindows.push({
        window: key || 'unknown',
        utilization,
        resetAt: new Date(resetAt).toISOString()
      })
    }
  }
  return activeWindows
}

const getUsageReserveWindows = (account, accountType, remainingPercent, now = Date.now()) => {
  const threshold = Number(remainingPercent)
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 100) {
    return []
  }
  return getUsageWindows(account, accountType, now).filter(
    (window) => 100 - window.utilization <= threshold
  )
}

const getUsageReservePause = (account, accountType, remainingPercent, now = Date.now()) =>
  getUsageReserveWindows(account, accountType, remainingPercent, now).sort(
    (a, b) => Date.parse(b.resetAt) - Date.parse(a.resetAt)
  )[0] || null

module.exports = { getUsageReservePause, getUsageReserveWindows, getUsageWindows }
