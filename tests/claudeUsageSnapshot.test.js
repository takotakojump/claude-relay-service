jest.useFakeTimers()

let storedAccount = {}
const mockGetClaudeAccount = jest.fn(async () => ({ ...storedAccount }))
const mockSetClaudeAccount = jest.fn(async (_accountId, accountData) => {
  storedAccount = { ...accountData }
})

jest.mock('../config/config', () => ({ claude: {}, system: { timezoneOffset: 8 } }), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: mockGetClaudeAccount,
  setClaudeAccount: mockSetClaudeAccount
}))
jest.mock('../src/utils/logger', () => {
  const noop = jest.fn()
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    success: noop,
    api: noop,
    database: noop,
    security: noop
  }
})
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn(() => null) }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({
  logRefreshStart: jest.fn(),
  logRefreshSuccess: jest.fn(),
  logRefreshError: jest.fn(),
  logTokenUsage: jest.fn(),
  logRefreshSkipped: jest.fn()
}))

const claudeAccountService = require('../src/services/account/claudeAccountService')

describe('Claude usage snapshots', () => {
  beforeEach(() => {
    storedAccount = { id: 'account-1', name: 'test-account' }
    jest.clearAllMocks()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('clears windows omitted from a successful upstream response', async () => {
    await claudeAccountService.updateClaudeUsageSnapshot('account-1', {
      five_hour: { utilization: 12.5, resets_at: '2026-07-28T01:00:00.000Z' },
      seven_day: { utilization: 50, resets_at: '2026-08-03T00:00:00.000Z' }
    })

    await claudeAccountService.updateClaudeUsageSnapshot('account-1', {
      five_hour: { utilization: 3, resets_at: '2026-07-28T02:00:00.000Z' }
    })

    expect(storedAccount.claudeFiveHourUtilization).toBe('3')
    expect(storedAccount.claudeSevenDayUtilization).toBe('')
    expect(storedAccount.claudeSevenDayResetsAt).toBe('')
  })

  it('invalidates all percentages when usage is unavailable', async () => {
    storedAccount = {
      id: 'account-1',
      claudeFiveHourUtilization: '80',
      claudeFiveHourResetsAt: '2026-07-28T01:00:00.000Z',
      claudeSevenDayUtilization: '40',
      claudeSevenDayResetsAt: '2026-08-03T00:00:00.000Z'
    }

    await claudeAccountService.clearClaudeUsageSnapshot('account-1')
    const snapshot = claudeAccountService.buildClaudeUsageSnapshot(storedAccount)

    expect(snapshot.fiveHour.utilization).toBeNull()
    expect(snapshot.fiveHour.resetsAt).toBe('')
    expect(snapshot.sevenDay.utilization).toBeNull()
    expect(snapshot.sevenDay.resetsAt).toBe('')
  })

  it('invalidates cached usage immediately when account authentication changes', async () => {
    storedAccount = {
      id: 'account-1',
      accountType: 'claude_max',
      claudeFiveHourUtilization: '80',
      claudeFiveHourResetsAt: '2026-07-28T01:00:00.000Z',
      claudeUsageUpdatedAt: '2026-07-27T23:59:00.000Z'
    }

    await claudeAccountService.updateAccount('account-1', { accountType: 'setup-token' })

    expect(storedAccount.claudeFiveHourUtilization).toBe('')
    expect(storedAccount.claudeFiveHourResetsAt).toBe('')
    expect(storedAccount.claudeUsageUpdatedAt).toBe('')
  })
})
