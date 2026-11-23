// In-place re-authorization for the OpenAI / Gemini / Droid / Grok account services:
// credentials are replaced on the same account ID, identity is checked where the
// platform exposes one, and error state is cleared afterwards.

const mockHashes = new Map()

const toRedisValue = (value) => (value === null || value === undefined ? '' : String(value))

const mockClient = {
  hset: jest.fn(async (key, fieldOrMap, value) => {
    const current = { ...(mockHashes.get(key) || {}) }
    if (fieldOrMap && typeof fieldOrMap === 'object') {
      for (const [field, fieldValue] of Object.entries(fieldOrMap)) {
        current[field] = toRedisValue(fieldValue)
      }
    } else {
      current[fieldOrMap] = toRedisValue(value)
    }
    mockHashes.set(key, current)
    return 1
  }),
  hgetall: jest.fn(async (key) => ({ ...(mockHashes.get(key) || {}) })),
  hdel: jest.fn(async (key, ...fields) => {
    const current = { ...(mockHashes.get(key) || {}) }
    for (const field of fields) {
      delete current[field]
    }
    mockHashes.set(key, current)
    return fields.length
  }),
  sadd: jest.fn(async () => 1),
  srem: jest.fn(async () => 1),
  del: jest.fn(async () => 1)
}

jest.mock(
  '../config/config',
  () => ({
    security: { encryptionKey: 'y'.repeat(32) },
    requestTimeout: 60000,
    system: { timezoneOffset: 8 }
  }),
  { virtual: true }
)
jest.mock('../src/models/redis', () => ({
  getClientSafe: () => mockClient,
  client: mockClient,
  getDroidAccount: async (id) => mockClient.hgetall(`droid:account:${id}`),
  setDroidAccount: async (id, data) => mockClient.hset(`droid:account:${id}`, data),
  addToIndex: jest.fn(async () => {}),
  getDateStringInTimezone: () => '2026-11-23'
}))
jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  clearTempUnavailable: jest.fn(async () => {}),
  recordErrorHistory: jest.fn(async () => {})
}))
jest.mock('../src/utils/webhookNotifier', () => ({
  sendAccountAnomalyNotification: jest.fn(async () => {})
}))
jest.mock('../src/services/tokenRefreshService', () => ({}))
jest.mock('../src/utils/tokenRefreshLogger', () => ({}))
jest.mock('../src/services/codexClientIdentityService', () => ({}))
jest.mock('../src/services/antigravityClient', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'none')
}))
jest.mock('axios', () => Object.assign(jest.fn(), { get: jest.fn(), post: jest.fn() }))

// Several services start cache-cleanup intervals at load; unref them so Jest can exit.
const realSetInterval = global.setInterval
global.setInterval = (fn, ms, ...args) => {
  const timer = realSetInterval(fn, ms, ...args)
  if (timer && typeof timer.unref === 'function') {
    timer.unref()
  }
  return timer
}
const openaiAccountService = require('../src/services/account/openaiAccountService')
const geminiAccountService = require('../src/services/account/geminiAccountService')
const droidAccountService = require('../src/services/account/droidAccountService')
const grokAccountService = require('../src/services/account/grokAccountService')
global.setInterval = realSetInterval

const { AccountIdentityMismatchError } = require('../src/utils/accountReauthHelper')

const hash = (key) => mockHashes.get(key) || {}

beforeEach(() => {
  mockHashes.clear()
  jest.clearAllMocks()
})

describe('openaiAccountService.reauthorizeAccount', () => {
  const KEY = 'openai:account:o1'

  const seed = () => {
    mockHashes.set(KEY, {
      id: 'o1',
      name: 'codex-dedicated',
      accountType: 'dedicated',
      priority: '20',
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: 'OpenAI账号认证失败（401错误）',
      unauthorizedAt: '2026-11-20T00:00:00.000Z',
      unauthorizedCount: '3',
      accessToken: openaiAccountService.encrypt('old-at'),
      refreshToken: openaiAccountService.encrypt('old-rt'),
      accountId: 'workspace-1',
      chatgptUserId: 'user-1',
      email: openaiAccountService.encrypt('owner@example.com')
    })
  }

  const payload = (accountInfo = {}) => ({
    tokens: { idToken: 'id-1', accessToken: 'new-at', refreshToken: 'new-rt', expires_in: 864000 },
    accountInfo: {
      accountId: 'workspace-1',
      chatgptUserId: 'user-1',
      email: 'owner@example.com',
      planType: 'pro',
      ...accountInfo
    }
  })

  it('swaps tokens, keeps config and clears the unauthorized state', async () => {
    seed()

    const result = await openaiAccountService.reauthorizeAccount('o1', payload())

    expect(result).toEqual({ accountId: 'o1', identityCheck: 'match' })
    const stored = hash(KEY)
    expect(openaiAccountService.decrypt(stored.accessToken)).toBe('new-at')
    expect(openaiAccountService.decrypt(stored.refreshToken)).toBe('new-rt')
    expect(stored.status).toBe('active')
    expect(stored.schedulable).toBe('true')
    expect(stored.unauthorizedCount).toBe('0')
    expect(stored.planType).toBe('pro')
    expect(stored.accountType).toBe('dedicated')
    expect(stored.priority).toBe('20')
  })

  it('refuses another ChatGPT workspace unless forced', async () => {
    seed()

    await expect(
      openaiAccountService.reauthorizeAccount('o1', payload({ accountId: 'workspace-2' }))
    ).rejects.toThrow(AccountIdentityMismatchError)
    expect(openaiAccountService.decrypt(hash(KEY).accessToken)).toBe('old-at')

    const forced = await openaiAccountService.reauthorizeAccount(
      'o1',
      payload({ accountId: 'workspace-2' }),
      { force: true }
    )
    expect(forced.identityCheck).toBe('forced')
    expect(hash(KEY).accountId).toBe('workspace-2')
  })

  it('requires both tokens', async () => {
    seed()

    await expect(
      openaiAccountService.reauthorizeAccount('o1', { tokens: { accessToken: 'only-at' } })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('geminiAccountService.reauthorizeAccount', () => {
  const KEY = 'gemini_account:g1'
  const encrypt = (value) => geminiAccountService.encrypt(value)

  const seed = (overrides = {}) => {
    mockHashes.set(KEY, {
      id: 'g1',
      name: 'gemini-dedicated',
      accountType: 'dedicated',
      status: 'error',
      schedulable: 'false',
      errorMessage: 'invalid_grant',
      oauthProvider: 'gemini-cli',
      projectId: 'configured-project',
      tempProjectId: 'stale-temp-project',
      accessToken: encrypt('old-at'),
      refreshToken: encrypt('old-rt'),
      ...overrides
    })
  }

  const tokens = (overrides = {}) => ({
    access_token: 'new-at',
    refresh_token: 'new-rt',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600 * 1000,
    ...overrides
  })

  it('writes the runtime token fields and recovers the account', async () => {
    seed()

    const result = await geminiAccountService.reauthorizeAccount('g1', {
      tokens: tokens(),
      oauthProvider: 'gemini-cli'
    })

    expect(result).toEqual({ accountId: 'g1', identityCheck: 'unverifiable', warnings: [] })
    const stored = hash(KEY)
    expect(geminiAccountService.decrypt(stored.accessToken)).toBe('new-at')
    expect(geminiAccountService.decrypt(stored.refreshToken)).toBe('new-rt')
    expect(stored.status).toBe('active')
    expect(stored.schedulable).toBe('true')
    expect(stored.projectId).toBe('configured-project')
    // Rediscovered from loadCodeAssist on the next request
    expect(stored.tempProjectId).toBe('')
  })

  it('keeps the previous refresh token and warns when Google returns none', async () => {
    seed()

    const result = await geminiAccountService.reauthorizeAccount('g1', {
      tokens: tokens({ refresh_token: undefined })
    })

    expect(result.warnings).toEqual(['refresh_token_missing'])
    expect(geminiAccountService.decrypt(hash(KEY).refreshToken)).toBe('old-rt')
  })

  it('keeps the random Antigravity project id and rejects a provider switch', async () => {
    seed({ oauthProvider: 'antigravity', tempProjectId: 'ag-123' })

    await geminiAccountService.reauthorizeAccount('g1', { tokens: tokens() })
    expect(hash(KEY).tempProjectId).toBe('ag-123')

    await expect(
      geminiAccountService.reauthorizeAccount('g1', {
        tokens: tokens(),
        oauthProvider: 'gemini-cli'
      })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('droidAccountService.reauthorizeAccount', () => {
  const KEY = 'droid:account:d1'

  const seed = (overrides = {}) => {
    mockHashes.set(KEY, {
      id: 'd1',
      name: 'droid-dedicated',
      accountType: 'dedicated',
      endpointType: 'anthropic',
      isActive: 'true',
      status: 'error',
      schedulable: 'false',
      errorMessage: 'Token refresh failed',
      unauthorizedAt: '2026-11-20T00:00:00.000Z',
      authenticationMethod: 'GoogleOAuth',
      organizationId: 'org-1',
      userId: 'user_1',
      ownerEmail: 'owner@example.com',
      accessToken: droidAccountService._encryptSensitiveData('old-at'),
      refreshToken: droidAccountService._encryptSensitiveData('old-rt'),
      ...overrides
    })
  }

  const deviceTokens = (user = {}) => ({
    access_token: 'device-at',
    refresh_token: 'device-rt',
    authentication_method: 'GoogleOAuth',
    user: { id: 'user_1', email: 'owner@example.com', first_name: 'Ada', ...user }
  })

  it('exchanges for an organization-scoped token and recovers the account', async () => {
    seed()
    const refreshSpy = jest
      .spyOn(droidAccountService, '_refreshTokensWithWorkOS')
      .mockResolvedValue({
        accessToken: 'org-at',
        refreshToken: 'org-rt',
        expiresAt: '2026-11-24T00:00:00.000Z',
        expiresIn: 28800,
        user: { id: 'user_1', email: 'owner@example.com', first_name: 'Ada' },
        organizationId: 'org-1',
        tokenType: 'Bearer',
        authenticationMethod: 'GoogleOAuth'
      })

    const result = await droidAccountService.reauthorizeAccount('d1', deviceTokens())

    expect(result).toEqual({ accountId: 'd1', identityCheck: 'match' })
    expect(refreshSpy).toHaveBeenCalledWith('device-rt', null, 'org-1')
    const stored = hash(KEY)
    expect(droidAccountService._decryptSensitiveData(stored.accessToken)).toBe('org-at')
    expect(droidAccountService._decryptSensitiveData(stored.refreshToken)).toBe('org-rt')
    expect(stored.status).toBe('active')
    expect(stored.schedulable).toBe('true')
    expect(stored.unauthorizedAt).toBeUndefined()
    expect(stored.ownerName).toBe('Ada')
    expect(stored.endpointType).toBe('anthropic')
    refreshSpy.mockRestore()
  })

  it('falls back to the device tokens and keeps a disabled account disabled', async () => {
    seed({ isActive: 'false' })
    const refreshSpy = jest
      .spyOn(droidAccountService, '_refreshTokensWithWorkOS')
      .mockRejectedValue(new Error('WorkOS unavailable'))

    await droidAccountService.reauthorizeAccount('d1', deviceTokens())

    const stored = hash(KEY)
    expect(droidAccountService._decryptSensitiveData(stored.accessToken)).toBe('device-at')
    expect(stored.isActive).toBe('false')
    refreshSpy.mockRestore()
  })

  it('rejects another WorkOS user and API-key accounts', async () => {
    seed()
    await expect(
      droidAccountService.reauthorizeAccount('d1', deviceTokens({ id: 'user_2' }))
    ).rejects.toThrow(AccountIdentityMismatchError)

    seed({ authenticationMethod: 'api_key' })
    await expect(
      droidAccountService.reauthorizeAccount('d1', deviceTokens())
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('grokAccountService.reauthorizeAccount', () => {
  const KEY = 'grok_account:x1'
  const encrypt = (value) => grokAccountService._encrypt(value)

  const seed = (overrides = {}) => {
    mockHashes.set(KEY, {
      id: 'x1',
      platform: 'grok',
      name: 'grok-dedicated',
      authType: 'oauth',
      accountType: 'dedicated',
      status: 'unauthorized',
      schedulable: 'false',
      errorMessage: '401',
      accessToken: encrypt('old-at'),
      refreshToken: encrypt('old-rt'),
      apiKey: encrypt(''),
      email: encrypt('owner@example.com'),
      ...overrides
    })
  }

  it('replaces the tokens and restores scheduling', async () => {
    seed()

    const result = await grokAccountService.reauthorizeAccount('x1', {
      tokens: { accessToken: 'new-at', refreshToken: 'new-rt', expiresAt: '2026-11-24T00:00:00Z' },
      accountInfo: { email: 'OWNER@example.com' }
    })

    expect(result).toEqual({ accountId: 'x1', identityCheck: 'match', warnings: [] })
    const stored = hash(KEY)
    expect(grokAccountService._decrypt(stored.accessToken)).toBe('new-at')
    expect(grokAccountService._decrypt(stored.refreshToken)).toBe('new-rt')
    expect(stored.status).toBe('active')
    expect(stored.schedulable).toBe('true')
    expect(stored.accountType).toBe('dedicated')
  })

  it('refuses a different xAI account and API-key accounts', async () => {
    seed()
    await expect(
      grokAccountService.reauthorizeAccount('x1', {
        tokens: { accessToken: 'new-at' },
        accountInfo: { email: 'other@example.com' }
      })
    ).rejects.toThrow(AccountIdentityMismatchError)

    seed({ authType: 'api_key' })
    await expect(
      grokAccountService.reauthorizeAccount('x1', { tokens: { accessToken: 'new-at' } })
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
