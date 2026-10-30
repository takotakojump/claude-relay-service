jest.mock('../src/models/redis', () => ({ getClientSafe: jest.fn(), getClaudeAccount: jest.fn() }))
jest.mock('../src/services/claudeRelayConfigService', () => ({
  getConfig: jest.fn().mockResolvedValue({ accountUsageReservePercent: 3 })
}))
jest.mock('../src/services/account/ccrAccountService', () => ({
  getSessionWindowSnapshot: jest.fn()
}))

const redis = require('../src/models/redis')
const claudeRelayConfigService = require('../src/services/claudeRelayConfigService')
const service = require('../src/services/accountUsageReserveService')

describe('temporary scheduling for usage reserve', () => {
  const start = Date.parse('2026-10-30T08:00:00Z')
  const fiveHourReset = new Date(start + 5 * 60 * 60 * 1000).toISOString()
  const weeklyReset = new Date(start + 7 * 24 * 60 * 60 * 1000).toISOString()
  let values

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(start)
    claudeRelayConfigService.getConfig.mockResolvedValue({ accountUsageReservePercent: 3 })
    values = new Map()
    redis.getClientSafe.mockReturnValue({
      get: jest.fn(async (key) => values.get(key) || null),
      set: jest.fn(async (key, value) => values.set(key, value)),
      del: jest.fn(async (key) => values.delete(key))
    })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('the nearest reset ends an override while a weekly pause remains', async () => {
    const account = {
      id: 'oauth-1',
      claudeFiveHourUtilization: 98,
      claudeFiveHourResetsAt: fiveHourReset,
      claudeSevenDayUtilization: 99,
      claudeSevenDayResetsAt: weeklyReset
    }
    const initial = await service.getState(account, 'claude-official')
    expect(initial.paused).toBe(true)
    const allowed = await service.setTemporaryScheduling(
      account,
      'claude-official',
      true,
      initial.version
    )
    expect(allowed.temporaryScheduling).toBe(true)
    expect(allowed.temporaryExpiresAt).toBe(fiveHourReset)

    jest.setSystemTime(start + 5 * 60 * 60 * 1000)
    const afterReset = await service.getState(account, 'claude-official')
    expect(afterReset.paused).toBe(true)
    expect(afterReset.windows.map((item) => item.window)).toEqual(['7d'])
  })

  test('a healthy five-hour window still limits a weekly override', async () => {
    const account = {
      id: 'oauth-healthy-5h',
      claudeFiveHourUtilization: 20,
      claudeFiveHourResetsAt: fiveHourReset,
      claudeSevenDayUtilization: 98,
      claudeSevenDayResetsAt: weeklyReset
    }
    const initial = await service.getState(account, 'claude-official')
    const allowed = await service.setTemporaryScheduling(
      account,
      'claude-official',
      true,
      initial.version
    )
    expect(allowed.windows.map((item) => item.window)).toEqual(['7d'])
    expect(allowed.temporaryExpiresAt).toBe(fiveHourReset)

    jest.setSystemTime(start + 5 * 60 * 60 * 1000)
    expect((await service.getState(account, 'claude-official')).paused).toBe(true)
  })

  test('a newly triggered window immediately cancels the override', async () => {
    const account = {
      id: 'oauth-2',
      claudeFiveHourUtilization: 98,
      claudeFiveHourResetsAt: fiveHourReset,
      claudeSevenDayUtilization: 50,
      claudeSevenDayResetsAt: weeklyReset
    }
    const initial = await service.getState(account, 'claude-official')
    await service.setTemporaryScheduling(account, 'claude-official', true, initial.version)
    account.claudeSevenDayUtilization = 98

    const state = await service.getState(account, 'claude-official')
    expect(state.paused).toBe(true)
    expect(state.temporaryScheduling).toBe(false)
    expect(values.has('usage_reserve_override:claude-official:oauth-2')).toBe(false)
  })

  test('an operator can restore the automatic pause before reset', async () => {
    const account = {
      id: 'ccr-1',
      sessionWindow: {
        windows: [{ key: '5h', utilization: 0.98, reset: fiveHourReset }]
      }
    }
    const initial = await service.getState(account, 'ccr')
    expect((await service.setTemporaryScheduling(account, 'ccr', true, initial.version)).paused).toBe(
      false
    )
    expect((await service.setTemporaryScheduling(account, 'ccr', false, initial.version)).paused).toBe(
      true
    )
  })

  test('a stale cancel never re-enables scheduling after another window triggers', async () => {
    const account = {
      id: 'oauth-stale',
      claudeFiveHourUtilization: 98,
      claudeFiveHourResetsAt: fiveHourReset,
      claudeSevenDayUtilization: 50,
      claudeSevenDayResetsAt: weeklyReset
    }
    const initial = await service.getState(account, 'claude-official')
    await service.setTemporaryScheduling(account, 'claude-official', true, initial.version)
    account.claudeSevenDayUtilization = 98
    expect((await service.getState(account, 'claude-official')).paused).toBe(true)

    expect(
      (await service.setTemporaryScheduling(account, 'claude-official', false, initial.version)).paused
    ).toBe(true)
    await expect(
      service.setTemporaryScheduling(account, 'claude-official', true, initial.version)
    ).rejects.toMatchObject({ code: 'USAGE_RESERVE_STATE_CHANGED' })
  })

  test('a sanitized Claude list entry reads its stored usage snapshot', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      id: 'oauth-3',
      claudeFiveHourUtilization: '98',
      claudeFiveHourResetsAt: fiveHourReset
    })
    const state = await service.getState({ id: 'oauth-3', claudeUsage: {} }, 'claude-official')
    expect(state.paused).toBe(true)
    expect(redis.getClaudeAccount).toHaveBeenCalledWith('oauth-3')
  })

  test('lowering the configured threshold releases an earlier pause', async () => {
    const account = {
      id: 'oauth-4',
      claudeFiveHourUtilization: 98,
      claudeFiveHourResetsAt: fiveHourReset
    }
    expect((await service.getState(account, 'claude-official')).paused).toBe(true)
    claudeRelayConfigService.getConfig.mockResolvedValue({ accountUsageReservePercent: 1 })
    expect((await service.getState(account, 'claude-official')).paused).toBe(false)
  })
})
