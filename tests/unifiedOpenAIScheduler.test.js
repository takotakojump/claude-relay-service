jest.mock('../src/services/account/openaiAccountService', () => ({
  setAccountRateLimited: jest.fn(),
  isAccountOverloaded: jest.fn().mockResolvedValue(false)
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  markAccountRateLimited: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}))
jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn((value) => value !== false && value !== 'false'),
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))

const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')

describe('UnifiedOpenAIScheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('markAccountRateLimited', () => {
    it('does not disable scheduling again when OpenAI-Responses auto protection is disabled', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'true'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.markAccountRateLimited).toHaveBeenCalledWith(
        'account-1',
        2
      )
      expect(openaiResponsesAccountService.updateAccount).not.toHaveBeenCalled()
    })

    it('keeps disabling scheduling for protected OpenAI-Responses accounts', async () => {
      openaiResponsesAccountService.getAccount.mockResolvedValue({
        id: 'account-1',
        disableAutoProtection: 'false'
      })

      await unifiedOpenAIScheduler.markAccountRateLimited(
        'account-1',
        'openai-responses',
        null,
        120
      )

      expect(openaiResponsesAccountService.updateAccount).toHaveBeenCalledWith(
        'account-1',
        expect.objectContaining({
          schedulable: 'false'
        })
      )
    })
  })
})

describe('capacity cooldown is a preference, not an exclusion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    openaiAccountService.isAccountOverloaded.mockResolvedValue(false)
  })

  describe('_preferNonOverloaded', () => {
    it('skips a cooled account when a healthy one exists', () => {
      const picked = unifiedOpenAIScheduler._preferNonOverloaded([
        { accountId: 'a', isOverloaded: true },
        { accountId: 'b', isOverloaded: false }
      ])

      expect(picked.accountId).toBe('b')
    })

    it('still returns an account when every candidate is cooled', () => {
      // 这是两个号的池子最关键的一条：全在冷却时也必须选出一个，
      // 否则一次容量抖动会让整池在冷却期内持续返回「没有可用账号」。
      const picked = unifiedOpenAIScheduler._preferNonOverloaded([
        { accountId: 'a', isOverloaded: true },
        { accountId: 'b', isOverloaded: true }
      ])

      expect(picked.accountId).toBe('a')
    })

    it('keeps the priority order when nothing is cooled', () => {
      const picked = unifiedOpenAIScheduler._preferNonOverloaded([
        { accountId: 'a' },
        { accountId: 'b' }
      ])

      expect(picked.accountId).toBe('a')
    })
  })

  describe('_ensureAccountReadyForScheduling', () => {
    it('parks a cooled account when the caller honors the cooldown', async () => {
      openaiAccountService.isAccountOverloaded.mockResolvedValue(true)

      const readiness = await unifiedOpenAIScheduler._ensureAccountReadyForScheduling(
        { name: 'acct', schedulable: true },
        'acct-1'
      )

      expect(readiness).toEqual({ canUse: false, reason: 'server_overloaded' })
    })

    it('ignores the cooldown for dedicated accounts, which have no alternative', async () => {
      openaiAccountService.isAccountOverloaded.mockResolvedValue(true)
      jest.spyOn(unifiedOpenAIScheduler, 'isAccountRateLimited').mockResolvedValue(false)

      const readiness = await unifiedOpenAIScheduler._ensureAccountReadyForScheduling(
        { name: 'acct', schedulable: true },
        'acct-1',
        { honorOverloadCooldown: false }
      )

      expect(readiness.canUse).toBe(true)
      unifiedOpenAIScheduler.isAccountRateLimited.mockRestore()
    })
  })
})
