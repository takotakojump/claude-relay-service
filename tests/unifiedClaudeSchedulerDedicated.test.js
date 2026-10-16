// Regression test: an API key bound to a dedicated Claude account must NEVER be
// silently routed to a different account.
//
// Bug: markAccountRateLimited sets schedulable='false' AND the relay writes a
// temp_unavailable key. The bound-account path checked temp_unavailable FIRST and only
// logged "falling back to pool", so the CLAUDE_DEDICATED_RATE_LIMITED throw was dead code
// and the dedicated key quietly used other accounts from the shared pool.

const mockConfig = { claude: {} }

jest.mock('../config/config', () => mockConfig, { virtual: true })
jest.mock('../src/services/account/claudeAccountService', () => ({
  isAccountRateLimited: jest.fn(),
  getAccountRateLimitInfo: jest.fn(),
  isAccountModelRateLimited: jest.fn(),
  getAccountModelRateLimitInfo: jest.fn(),
  clearExpiredModelRateLimit: jest.fn()
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/ccrAccountService', () => ({
  getAccount: jest.fn(),
  isAccountRateLimited: jest.fn(),
  isAccountQuotaExceeded: jest.fn(),
  isAccountOverloaded: jest.fn(),
  isSubscriptionExpired: jest.fn(),
  isModelSupported: jest.fn(() => true)
}))
jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(),
  getClientSafe: jest.fn()
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) =>
    [...accounts].sort((a, b) => (Number(a.priority) || 50) - (Number(b.priority) || 50))
  )
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const ccrAccountService = require('../src/services/account/ccrAccountService')
const redis = require('../src/models/redis')
const scheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

const BOUND_ID = 'acct-0w'
// mirrors production: API key "river" bound to account "0w"
const apiKeyData = { id: 'key-river', name: 'river', claudeAccountId: BOUND_ID }

const healthyAccount = {
  id: BOUND_ID,
  name: '0w',
  isActive: 'true',
  status: 'active',
  schedulable: 'true'
}

describe('dedicated (bound) Claude account never silently falls back to the shared pool', () => {
  let tempSpy

  beforeEach(() => {
    jest.clearAllMocks()
    mockConfig.claude = {}
    claudeAccountService.isAccountRateLimited.mockResolvedValue(false)
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(false)
    claudeAccountService.clearExpiredModelRateLimit.mockResolvedValue({ success: true })
    claudeAccountService.getAccountRateLimitInfo.mockResolvedValue({
      rateLimitEndAt: '2026-07-07T07:00:00.000Z'
    })
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({ resetAt: null })
    ccrAccountService.getAccount.mockResolvedValue(null)
    ccrAccountService.isAccountRateLimited.mockResolvedValue(false)
    ccrAccountService.isAccountQuotaExceeded.mockResolvedValue(false)
    ccrAccountService.isAccountOverloaded.mockResolvedValue(false)
    ccrAccountService.isSubscriptionExpired.mockReturnValue(false)
    redis.getClientSafe.mockReturnValue({ incr: jest.fn().mockResolvedValue(1) })
    tempSpy = jest.spyOn(scheduler, 'isAccountTemporarilyUnavailable').mockResolvedValue(false)
  })

  afterEach(() => {
    tempSpy.mockRestore()
  })

  it('uses the bound account when it is healthy', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).resolves.toEqual({ accountId: BOUND_ID, accountType: 'claude-official' })
  })

  it('throws CLAUDE_DEDICATED_RATE_LIMITED when rate limited AND temp-unavailable (the production bug)', async () => {
    // markAccountRateLimited sets schedulable=false + rateLimitAutoStopped,
    // and the relay also writes temp_unavailable — the exact state of "0w".
    redis.getClaudeAccount.mockResolvedValue({
      ...healthyAccount,
      schedulable: 'false',
      rateLimitStatus: 'limited',
      rateLimitAutoStopped: 'true'
    })
    claudeAccountService.isAccountRateLimited.mockResolvedValue(true)
    tempSpy.mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_RATE_LIMITED', accountId: BOUND_ID })
  })

  it('throws CLAUDE_DEDICATED_RATE_LIMITED when only schedulable=false via rate-limit auto-stop', async () => {
    redis.getClaudeAccount.mockResolvedValue({
      ...healthyAccount,
      schedulable: 'false',
      rateLimitAutoStopped: 'true'
    })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_RATE_LIMITED' })
  })

  it('throws CLAUDE_DEDICATED_RATE_LIMITED when the requested model family is limited', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    claudeAccountService.isAccountModelRateLimited.mockResolvedValue(true)
    claudeAccountService.getAccountModelRateLimitInfo.mockResolvedValue({ resetAt: 'soon' })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-sonnet-4-5')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_RATE_LIMITED', modelFamily: 'sonnet' })
  })

  it('throws CLAUDE_DEDICATED_UNAVAILABLE when only temporarily unavailable', async () => {
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    tempSpy.mockResolvedValue(true)

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({
      code: 'CLAUDE_DEDICATED_UNAVAILABLE',
      reason: 'temporarily_unavailable'
    })
  })

  it('throws CLAUDE_DEDICATED_UNAVAILABLE when the bound account is inactive', async () => {
    redis.getClaudeAccount.mockResolvedValue({ ...healthyAccount, isActive: 'false' })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toMatchObject({ code: 'CLAUDE_DEDICATED_UNAVAILABLE', reason: 'inactive_or_error' })
  })

  it('falls back to the shared pool ONLY when dedicatedAccountFallback is enabled', async () => {
    mockConfig.claude = { dedicatedAccountFallback: true }
    redis.getClaudeAccount.mockResolvedValue(healthyAccount)
    tempSpy.mockResolvedValue(true)
    const poolSpy = jest.spyOn(scheduler, '_getAllAvailableAccounts').mockResolvedValue([])

    await expect(
      scheduler.selectAccountForApiKey(apiKeyData, null, 'claude-opus-4-8')
    ).rejects.toThrow(/No available Claude accounts/)
    expect(poolSpy).toHaveBeenCalled()

    poolSpy.mockRestore()
  })

  it('includes both healthy bound accounts and gives the higher-priority account more slots', async () => {
    const ccrId = 'ccr-wuejyo'
    const apiKeyWithCcr = { ...apiKeyData, id: 'key-balanced', ccrAccountId: ccrId }
    redis.getClaudeAccount.mockResolvedValue({ ...healthyAccount, priority: 10 })
    ccrAccountService.getAccount.mockResolvedValue({
      id: ccrId,
      name: 'WuejyoTaro',
      isActive: true,
      status: 'active',
      schedulable: true,
      priority: 50,
      supportedModels: []
    })
    const incr = jest.fn()
    for (let value = 1; value <= 6; value += 1) {
      incr.mockResolvedValueOnce(value)
    }
    redis.getClientSafe.mockReturnValue({ incr })

    const selections = []
    for (let i = 0; i < 6; i += 1) {
      selections.push(
        await scheduler.selectAccountForApiKey(apiKeyWithCcr, null, 'claude-sonnet-4-5')
      )
    }

    expect(selections).toEqual([
      { accountId: BOUND_ID, accountType: 'claude-official' },
      { accountId: BOUND_ID, accountType: 'claude-official' },
      { accountId: BOUND_ID, accountType: 'claude-official' },
      { accountId: BOUND_ID, accountType: 'claude-official' },
      { accountId: BOUND_ID, accountType: 'claude-official' },
      { accountId: ccrId, accountType: 'ccr' }
    ])
  })

  it('round-robins bound accounts 1:1 when their priorities are equal', async () => {
    const ccrId = 'ccr-wuejyo'
    const apiKeyWithCcr = { ...apiKeyData, id: 'key-balanced-tie', ccrAccountId: ccrId }
    redis.getClaudeAccount.mockResolvedValue({
      ...healthyAccount,
      priority: 20,
      lastUsedAt: '2026-07-07T07:00:00.000Z'
    })
    ccrAccountService.getAccount.mockResolvedValue({
      id: ccrId,
      name: 'WuejyoTaro',
      isActive: true,
      status: 'active',
      schedulable: true,
      priority: 20,
      lastUsedAt: '2026-07-07T06:00:00.000Z',
      supportedModels: []
    })
    const incr = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    redis.getClientSafe.mockReturnValue({ incr })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyWithCcr, null, 'claude-sonnet-4-5')
    ).resolves.toEqual({ accountId: BOUND_ID, accountType: 'claude-official' })
    await expect(
      scheduler.selectAccountForApiKey(apiKeyWithCcr, null, 'claude-sonnet-4-5')
    ).resolves.toEqual({ accountId: ccrId, accountType: 'ccr' })
  })

  it('does not let an existing Claude session binding disable dual-account balancing', async () => {
    const ccrId = 'ccr-wuejyo'
    const apiKeyWithCcr = { ...apiKeyData, id: 'key-bound-session', ccrAccountId: ccrId }
    redis.getClaudeAccount.mockResolvedValue({ ...healthyAccount, priority: 50 })
    ccrAccountService.getAccount.mockResolvedValue({
      id: ccrId,
      name: 'WuejyoTaro',
      isActive: true,
      status: 'active',
      schedulable: true,
      priority: 50,
      supportedModels: []
    })
    const incr = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    redis.getClientSafe.mockReturnValue({ incr })

    await expect(
      scheduler.selectAccountForApiKey(
        apiKeyWithCcr,
        null,
        'claude-sonnet-4-5',
        { accountId: BOUND_ID, accountType: 'claude-official' }
      )
    ).resolves.toEqual({ accountId: BOUND_ID, accountType: 'claude-official' })
    await expect(
      scheduler.selectAccountForApiKey(
        apiKeyWithCcr,
        null,
        'claude-sonnet-4-5',
        { accountId: BOUND_ID, accountType: 'claude-official' }
      )
    ).resolves.toEqual({ accountId: ccrId, accountType: 'ccr' })
  })

  it('uses the remaining bound account when the other account is unavailable', async () => {
    const ccrId = 'ccr-wuejyo'
    const apiKeyWithCcr = { ...apiKeyData, id: 'key-fallback', ccrAccountId: ccrId }
    redis.getClaudeAccount.mockResolvedValue({ ...healthyAccount, isActive: 'false' })
    ccrAccountService.getAccount.mockResolvedValue({
      id: ccrId,
      name: 'WuejyoTaro',
      isActive: true,
      status: 'active',
      schedulable: true,
      supportedModels: []
    })

    await expect(
      scheduler.selectAccountForApiKey(apiKeyWithCcr, null, 'claude-sonnet-4-5')
    ).resolves.toEqual({ accountId: ccrId, accountType: 'ccr' })
  })
})
