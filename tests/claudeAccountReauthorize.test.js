// Re-authorizing a Claude account must swap credentials in place: same account ID, every
// binding/config field untouched, error state cleared and scheduling restored.

const mockStore = new Map()
const stripPrefix = (key) => key.replace(/^claude:account:/, '')

jest.mock('../config/config', () => ({ security: { encryptionKey: 'x'.repeat(32) }, claude: {} }), {
  virtual: true
})
jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn(async (id) => ({ ...(mockStore.get(id) || {}) })),
  setClaudeAccount: jest.fn(async (id, data) => {
    mockStore.set(id, { ...(mockStore.get(id) || {}), ...data })
  }),
  client: {
    hdel: jest.fn(async (key, ...fields) => {
      const id = stripPrefix(key)
      const current = { ...(mockStore.get(id) || {}) }
      for (const field of fields) {
        delete current[field]
      }
      mockStore.set(id, current)
      return fields.length
    }),
    del: jest.fn(async () => 1)
  }
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/utils/webhookNotifier', () => ({ sendAccountAnomalyNotification: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn(async () => {}),
  recordErrorHistory: jest.fn(async () => {})
}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }))

// The service constructor starts a cache-cleanup setInterval at load; unref it so the
// timer never keeps Jest alive.
const realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = realSetInterval(fn, ms, ...args)
  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  return timer
}
const claudeAccountService = require('../src/services/account/claudeAccountService')
global.setInterval = realSetInterval

const axios = require('axios')
const { AccountIdentityMismatchError } = require('../src/utils/accountReauthHelper')

const ACCOUNT_ID = 'claude-acct-1'

const seedBrokenAccount = (overrides = {}) => {
  mockStore.clear()
  mockStore.set(ACCOUNT_ID, {
    id: ACCOUNT_ID,
    name: 'dedicated-claude',
    platform: 'claude',
    accountType: 'dedicated',
    priority: '10',
    proxy: '',
    isActive: 'true',
    status: 'unauthorized',
    schedulable: 'false',
    errorMessage: 'Account unauthorized (401 errors detected)',
    unauthorizedAt: '2026-11-20T00:00:00.000Z',
    accessToken: claudeAccountService._encryptSensitiveData('old-access'),
    refreshToken: claudeAccountService._encryptSensitiveData('old-refresh'),
    email: claudeAccountService._encryptSensitiveData('owner@example.com'),
    scopes: 'user:inference user:profile',
    extInfo: JSON.stringify({ account_uuid: 'acc-uuid-1', org_uuid: 'org-uuid-1' }),
    claudeFiveHourUtilization: '88',
    ...overrides
  })
}

const oauthPayload = (overrides = {}) => ({
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  expiresAt: Date.now() + 8 * 60 * 60 * 1000,
  scopes: ['user:inference', 'user:profile'],
  organization: { uuid: 'org-uuid-1' },
  account: { uuid: 'acc-uuid-1', email_address: 'owner@example.com' },
  extInfo: null,
  ...overrides
})

const stored = () => mockStore.get(ACCOUNT_ID)

describe('claudeAccountService.reauthorizeAccount', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    axios.get.mockRejectedValue(new Error('profile endpoint unavailable in tests'))
    seedBrokenAccount()
  })

  it('replaces credentials in place and restores a broken account', async () => {
    const result = await claudeAccountService.reauthorizeAccount(ACCOUNT_ID, oauthPayload())

    expect(result).toEqual({ accountId: ACCOUNT_ID, identityCheck: 'match', authType: 'oauth' })

    const account = stored()
    expect(claudeAccountService._decryptSensitiveData(account.accessToken)).toBe('new-access')
    expect(claudeAccountService._decryptSensitiveData(account.refreshToken)).toBe('new-refresh')
    expect(account.status).toBe('active')
    expect(account.schedulable).toBe('true')
    expect(account.unauthorizedAt).toBeUndefined()
    expect(account.errorMessage).toBeUndefined()
    expect(account.claudeFiveHourUtilization).toBe('')
    // Binding-related config is untouched
    expect(account.id).toBe(ACCOUNT_ID)
    expect(account.accountType).toBe('dedicated')
    expect(account.priority).toBe('10')
    expect(account.name).toBe('dedicated-claude')
    // Profile refresh is best-effort and must not fail the re-authorization
    expect(axios.get).toHaveBeenCalledTimes(1)
  })

  it('rejects a different upstream account without touching stored credentials', async () => {
    const payload = oauthPayload({
      account: { uuid: 'acc-uuid-OTHER', email_address: 'someone-else@example.com' }
    })

    await expect(claudeAccountService.reauthorizeAccount(ACCOUNT_ID, payload)).rejects.toThrow(
      AccountIdentityMismatchError
    )

    const account = stored()
    expect(claudeAccountService._decryptSensitiveData(account.accessToken)).toBe('old-access')
    expect(account.status).toBe('unauthorized')
  })

  it('replaces a mismatched identity when forced', async () => {
    const payload = oauthPayload({
      organization: { uuid: 'org-uuid-2' },
      account: { uuid: 'acc-uuid-2', email_address: 'new-owner@example.com' }
    })

    const result = await claudeAccountService.reauthorizeAccount(ACCOUNT_ID, payload, {
      force: true
    })

    expect(result.identityCheck).toBe('forced')
    const account = stored()
    expect(JSON.parse(account.extInfo)).toEqual({
      account_uuid: 'acc-uuid-2',
      org_uuid: 'org-uuid-2'
    })
    expect(claudeAccountService._decryptSensitiveData(account.email)).toBe('new-owner@example.com')
  })

  it('clears the old refresh token when switching to a Setup Token', async () => {
    const result = await claudeAccountService.reauthorizeAccount(
      ACCOUNT_ID,
      oauthPayload({ refreshToken: '', scopes: ['user:inference'] })
    )

    expect(result.authType).toBe('setup-token')
    const account = stored()
    expect(account.refreshToken).toBe('')
    expect(account.scopes).toBe('user:inference')
    expect(axios.get).not.toHaveBeenCalled()
  })

  it('validates the payload and the account', async () => {
    await expect(
      claudeAccountService.reauthorizeAccount(ACCOUNT_ID, { refreshToken: 'only-refresh' })
    ).rejects.toMatchObject({ statusCode: 400 })

    await expect(
      claudeAccountService.reauthorizeAccount('missing-account', oauthPayload())
    ).rejects.toThrow('Account not found')
  })
})
