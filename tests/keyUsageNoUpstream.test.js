/**
 * Guards the contract that /apiStats/api/key-usage is purely observational.
 *
 * Unlike keyUsageRoute.test.js — which stubs the services to assert response shape — this suite
 * runs the REAL apiKeyService and both account services, faking only Redis. axios is rigged to
 * throw on every call, so any upstream request anywhere in the chain fails the test loudly.
 *
 * This matters because a monitoring script polling this endpoint on a timer would otherwise turn
 * into periodic fixed-interval traffic against ChatGPT/Anthropic.
 */

// The real account services install module-level cache-cleanup intervals on require; fake timers
// keep them from holding the event loop open after the suite finishes.
jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })

const mockAxiosCalls = []

const mockAxiosError = (method) => {
  mockAxiosCalls.push(method)
  throw new Error(`UPSTREAM CALL ATTEMPTED via axios.${method}`)
}

jest.mock('axios', () => {
  const fn = jest.fn(() => mockAxiosError('request'))
  fn.get = jest.fn(() => mockAxiosError('get'))
  fn.post = jest.fn(() => mockAxiosError('post'))
  fn.put = jest.fn(() => mockAxiosError('put'))
  fn.delete = jest.fn(() => mockAxiosError('delete'))
  fn.request = jest.fn(() => mockAxiosError('request'))
  fn.create = jest.fn(() => fn)
  return fn
})

jest.mock(
  '../config/config',
  () => ({
    security: { encryptionKey: 'test-encryption-key-32-characters', apiKeyPrefix: 'cr_' },
    system: { timezoneOffset: 8 },
    claude: {},
    openai: {},
    requestTimeout: 600000
  }),
  { virtual: true }
)

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

const mockCrypto = require('crypto')
const mockApiKey = 'cr_no_upstream_probe_key'
const mockHashedKey = mockCrypto
  .createHash('sha256')
  .update(`${mockApiKey}test-encryption-key-32-characters`)
  .digest('hex')

// Minimal Redis stand-in holding one API key bound to one dedicated Codex account.
const mockRedisState = {
  hashMap: {},
  apiKey: {},
  openaiAccount: {}
}

const mockRedis = {
  getClientSafe: () => ({
    get: jest.fn(async () => null),
    hget: jest.fn(async (key, field) =>
      key === 'apikey:hash_map' ? mockRedisState.hashMap[field] || null : null
    ),
    hgetall: jest.fn(async (key) => {
      if (key === `apikey:${mockRedisState.apiKey.id}`) {
        return { ...mockRedisState.apiKey }
      }
      if (key === `openai:account:${mockRedisState.openaiAccount.id}`) {
        return { ...mockRedisState.openaiAccount }
      }
      return {}
    })
  }),
  findApiKeyByHash: jest.fn(async (hash) =>
    hash === mockHashedKey ? { ...mockRedisState.apiKey } : null
  ),
  getApiKey: jest.fn(async () => ({ ...mockRedisState.apiKey, serviceLimits: {} })),
  getUsageStats: jest.fn(async () => ({ total: { requests: 1, allTokens: 10 } })),
  getDailyCost: jest.fn(async () => 1),
  getCostStats: jest.fn(async () => ({ total: 2 })),
  getWeeklyOpusCost: jest.fn(async () => 0),
  getServiceDailyCost: jest.fn(async () => 0),
  getServiceWeeklyCost: jest.fn(async () => 0),
  peekServiceWindow: jest.fn(async () => ({
    currentRequests: 0,
    currentCost: 0,
    windowStart: null,
    resetAt: null
  })),
  getNextDailyResetTime: () => new Date('2026-08-07T00:00:00.000Z'),
  getNextResetTime: () => new Date('2026-08-10T00:00:00.000Z'),
  getClaudeAccount: jest.fn(async () => ({})),
  getOpenAiAccount: jest.fn(async () => ({}))
}

jest.mock('../src/models/redis', () => mockRedis)

const express = require('express')
const request = require('supertest')
const apiStatsRoutes = require('../src/routes/apiStats')
const axios = require('axios')

const app = express()
app.use(express.json())
app.use('/apiStats', apiStatsRoutes)

describe('GET /apiStats/api/key-usage makes no upstream requests', () => {
  beforeEach(() => {
    mockAxiosCalls.length = 0
    mockRedisState.apiKey = {
      id: 'key-probe',
      name: 'probe',
      apiKey: mockHashedKey,
      isActive: 'true',
      isActivated: 'true',
      permissions: 'all',
      tokenLimit: '0',
      concurrencyLimit: '0',
      rateLimitWindow: '60',
      rateLimitRequests: '100',
      createdAt: '2026-07-01T00:00:00.000Z',
      openaiAccountId: 'acc-probe',
      weeklyResetDay: '1',
      weeklyResetHour: '0'
    }
    mockRedisState.hashMap[mockHashedKey] = 'key-probe'
    mockRedisState.openaiAccount = {
      id: 'acc-probe',
      accountType: 'dedicated',
      platform: 'openai',
      isActive: 'true',
      // 一份陈旧且带 Sol 附加桶的缓存快照
      codexUsageSnapshot: JSON.stringify({
        updatedAt: '2026-08-01T00:00:00.000Z',
        source: 'wham',
        rateLimitReachedType: null,
        limits: [
          {
            limitId: 'codex',
            limitName: 'Codex',
            primary: {
              usedPercent: 5,
              windowMinutes: 10080,
              resetAt: '2026-08-09T00:00:00.000Z'
            },
            secondary: null
          }
        ]
      }),
      // 过期 token + 存在 refreshToken：如果读路径会刷新 token，就会打上游
      expiresAt: '2020-01-01T00:00:00.000Z',
      accessToken: 'encrypted-placeholder',
      refreshToken: 'encrypted-placeholder'
    }
    jest.clearAllMocks()
  })

  afterAll(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('answers without touching axios even when the account token is expired', async () => {
    const res = await request(app)
      .get('/apiStats/api/key-usage')
      .set('Authorization', `Bearer ${mockApiKey}`)

    expect(res.status).toBe(200)
    expect(mockAxiosCalls).toEqual([])
    expect(axios.get).not.toHaveBeenCalled()
    expect(axios.post).not.toHaveBeenCalled()
    expect(axios).not.toHaveBeenCalled()
  })

  it('still serves the cached codex snapshot, flagged stale', async () => {
    const res = await request(app)
      .get('/apiStats/api/key-usage')
      .set('Authorization', `Bearer ${mockApiKey}`)

    const codexUsage = res.body.data.accounts.openai.codexUsage
    expect(codexUsage.isStale).toBe(true)
    expect(codexUsage.limits[0].primary.windowMinutes).toBe(10080)
    expect(mockAxiosCalls).toEqual([])
  })

  it('repeated polling stays free of upstream traffic', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .get('/apiStats/api/key-usage')
        .set('Authorization', `Bearer ${mockApiKey}`)
      expect(res.status).toBe(200)
    }

    expect(mockAxiosCalls).toEqual([])
  })
})
