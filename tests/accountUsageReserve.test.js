const { getUsageReservePause } = require('../src/utils/accountUsageReserve')

const now = Date.parse('2026-10-29T08:00:00Z')
const future = new Date(now + 5 * 60 * 60 * 1000).toISOString()
const past = new Date(now - 1000).toISOString()

describe('account usage reserve', () => {
  test('pauses an OAuth account at the configured reserve and resumes after reset', () => {
    const account = {
      claudeFiveHourUtilization: '97',
      claudeFiveHourResetsAt: future,
      claudeSevenDayUtilization: '50',
      claudeSevenDayResetsAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString()
    }
    expect(getUsageReservePause(account, 'claude-official', 3, now)?.window).toBe('5h')
    expect(getUsageReservePause(account, 'claude-official', 3, now + 5 * 60 * 60 * 1000)).toBeNull()
  })

  test('keeps a weekly window paused after a five hour window resets', () => {
    const account = {
      claudeFiveHourUtilization: '99',
      claudeFiveHourResetsAt: past,
      claudeSevenDayUtilization: '98',
      claudeSevenDayResetsAt: future
    }
    expect(getUsageReservePause(account, 'claude-official', 3, now)?.window).toBe('7d')
  })

  test('uses the latest reset when several windows reach the reserve', () => {
    const account = {
      claudeFiveHourUtilization: '98',
      claudeFiveHourResetsAt: new Date(now + 3600000).toISOString(),
      claudeSevenDayUtilization: '98',
      claudeSevenDayResetsAt: future
    }
    expect(getUsageReservePause(account, 'claude-official', 3, now)?.window).toBe('7d')
  })

  test('uses live Claude response headers without an admin usage refresh', () => {
    const account = {
      claudeRateLimitWindows: JSON.stringify({
        observedAt: new Date(now).toISOString(),
        windows: [{ key: '5h', utilization: 0.98, reset: (now + 3600000) / 1000 }]
      })
    }
    expect(getUsageReservePause(account, 'claude-official', 3, now)?.window).toBe('5h')
  })

  test('newer response headers replace an older OAuth window but preserve other windows', () => {
    const account = {
      claudeUsageUpdatedAt: new Date(now - 60000).toISOString(),
      claudeFiveHourUtilization: '99',
      claudeFiveHourResetsAt: future,
      claudeSevenDayUtilization: '98',
      claudeSevenDayResetsAt: future,
      claudeRateLimitWindows: JSON.stringify({
        observedAt: new Date(now).toISOString(),
        windows: [{ key: '5h', utilization: 0.2, reset: (now + 3600000) / 1000 }]
      })
    }
    expect(getUsageReservePause(account, 'claude-official', 3, now)?.window).toBe('7d')
    account.claudeSevenDayUtilization = '50'
    expect(getUsageReservePause(account, 'claude-official', 3, now)).toBeNull()
  })

  test('an old partial header window does not override a newer OAuth refresh', () => {
    const account = {
      claudeUsageUpdatedAt: new Date(now - 10000).toISOString(),
      claudeSevenDayUtilization: '50',
      claudeSevenDayResetsAt: future,
      claudeRateLimitWindows: JSON.stringify({
        observedAt: new Date(now).toISOString(),
        windows: [
          {
            key: '7d',
            utilization: 0.99,
            reset: (now + 3600000) / 1000,
            observedAt: new Date(now - 60000).toISOString()
          }
        ]
      })
    }
    expect(getUsageReservePause(account, 'claude-official', 3, now)).toBeNull()
  })

  test('uses CCR ratio utilization and Unix reset time', () => {
    const account = {
      sessionWindow: JSON.stringify({
        windows: [{ key: '7d', utilization: 0.975, reset: (now + 10000) / 1000 }]
      })
    }
    expect(getUsageReservePause(account, 'ccr', 3, now)?.utilization).toBe(97.5)
    expect(getUsageReservePause(account, 'ccr', 2, now)).toBeNull()
  })

  test('ignores expired or incomplete snapshots and a disabled threshold', () => {
    const account = {
      sessionWindow: {
        windows: [
          { key: '5h', utilization: 0.99, reset: past },
          { key: '7d', utilization: 0.99 }
        ]
      }
    }
    expect(getUsageReservePause(account, 'ccr', 3, now)).toBeNull()
    expect(getUsageReservePause(account, 'ccr', 0, now)).toBeNull()
  })
})
